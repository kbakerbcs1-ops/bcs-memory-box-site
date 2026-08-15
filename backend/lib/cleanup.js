// ============================================================================
// Cleanup pipeline — turns a customer's uploaded recordings into a polished
// memoir document. This runs ASYNCHRONOUSLY (not in the HTTP request) because
// it takes minutes.
//
// Pipeline:
//   1. Mark customer status = 'processing'
//   2. For each recording: transcribe via AssemblyAI (if not done yet)
//   3. Send all transcripts to Claude with the memoir-organization prompt
//   4. Receive Markdown back
//   5. Render Markdown → .docx
//   6. Upload .docx to R2
//   7. Save draft row (status = 'ready_for_review')
//   8. Mark customer status = 'draft_ready'
//   9. Email Ken: "draft ready for [customer], review in admin"
//
// On any failure: customer status = 'error', email Ken with the detail.
// ============================================================================

const db = require('./db');
const storage = require('./storage');
const bookPdf = require('./bookPdf');
const coverPdf = require('./coverPdf');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  HeadingLevel, LevelFormat, PageOrientation, ImageRun,
} = require('docx');
const { imageSize } = require('image-size');

// ----------------------------------------------------------------------------
// The memoir-cleanup system prompt sent to Claude.
// Iterated carefully; preserves voice, organizes into four sections, doesn't
// fabricate facts. Reads many transcripts; outputs a single Markdown memoir.
// ----------------------------------------------------------------------------
const MEMOIR_SYSTEM_PROMPT = [
"You are a gifted memoir writer. Your job is to turn a senior's recorded life story into a finished memoir that reads like a warm, flowing STORY — never a transcript, never a list of names and dates. The senior recorded a series of audio clips, transcribed below and labeled [RECORDING N - filename]. They spoke in whatever order things came to them, with tangents, repetition, and false starts. Shape what they said into a real book, in THEIR OWN VOICE.",
"",
"THREE UNBREAKABLE PRINCIPLES:",
"1. CHAPTERS FIT THE LIFE. Do NOT use a fixed template of sections. Read everything first, understand the shape of THIS particular life, and divide it into the chapters that fit IT. Give each chapter an evocative, specific title that carries a bit of the story in it (never 'Chapter 3', never a bland label like 'Early Life'). Aim for a handful of chapters, ending with a short reflective closing chapter.",
"2. THEIR OWN VOICE. Keep their exact vocabulary, idioms, rhythm, and level of formality. Folksy stays folksy; plain stays plain; formal stays formal. The finished book must sound like THIS person talking. Never impose a fancy or literary 'house voice' that isn't theirs.",
"3. STRICTLY THEIR OWN WORDS - smoothed, never invented. This is the firm line and it is absolute. You MAY: reorder and group what they said, connect fragments into flowing paragraphs, trim filler/repetition/false starts, fix grammar, repair incomplete or garbled spoken sentences so each one reads smoothly and completely (for example, restoring a dropped connecting word so 'a direction the storm wasn't coming' becomes 'a direction the storm wasn't coming from'), and correct obvious transcription errors (especially garbled proper names). You MAY NOT: invent a memory, scene, place, event, feeling, or line of dialogue; add sensory details they never mentioned; assign feelings they did not express; or fill a gap with a plausible-sounding fact or date. Every sentence must be something they ACTUALLY TOLD US - just told better. If you cannot point to where a sentence came from in their recordings, do not write it. Preserve their uncertainty ('I think it was around 1962' stays 'around 1962'); never fabricate certainty.",
"",
"HOW TO WRITE IT:",
"- OPEN ON A VIVID, REAL MEMORY - never on birth dates or genealogy. Find the most evocative TRUE thing they said and lead the whole book with it. (You are selecting and sequencing a real memory for impact, not inventing one.)",
"- Within each chapter, put things in a natural order (usually chronological) and connect the fragments into flowing paragraphs, using only the lightest connective transitions ('The next thing I remember is...', 'Then there was...').",
"- READ EVERY SENTENCE FOR FLOW. People speak in fragments and often drop a small word or leave a clause dangling; quietly complete and straighten each sentence so it is grammatical and reads smoothly aloud - restoring the small word they clearly meant (a dropped 'from', 'to', 'that', and the like) and untangling run-ons, WITHOUT adding any new information, detail, or event. If a sentence would make a reader stop and re-read, fix it. This is smoothing their meaning into clear English, never inventing.",
"- Tell each memory as a little scene when they gave it that shape: what happened, and what it meant - in their own telling. Do not flatten a good story back into a bare fact.",
"- WEAVE dates, places, and names naturally into the prose. Do NOT pile them into lists.",
"- Combine multiple recordings about the same topic into ONE coherent passage; never repeat the same anecdote twice.",
"- Render painful memories honestly but gently, keeping the person's own restraint. Never force emotion they did not express, and never sensationalize.",
"",
"GENEALOGY GOES AT THE BACK. Keep the pure names-and-dates (parents, grandparents, ancestors, birth years) OUT of the opening and out of the body. If they gave genealogy, gather it into a single final chapter titled exactly '## Family Roots' at the very end - a short, clean summary of who came before them. The body of the book is THE LIFE ITSELF; the family names and dates live on this back page for those who want them.",
"",
"OUTPUT FORMAT - return ONLY clean Markdown, nothing else (no preamble, no notes). Use this structure:",
"",
"# The Life of [Storyteller's first name]",
"",
"## [An evocative chapter title]",
"[flowing prose]",
"",
"## [The next evocative chapter title]",
"[flowing prose]",
"",
"... as many chapters as this life needs ...",
"",
"## Reflections",
"[a short closing in their own looking-back]",
"",
"## Family Roots",
"[include this heading ONLY if they gave genealogy; a short clean summary of parents/grandparents/ancestors and years]",
"",
"If they simply did not talk about some part of life, do NOT force a chapter for it and do NOT write filler - just leave it out.",
"",
"PHOTOGRAPHS (when a photo list is provided in the user's message):",
"The user may give you a numbered list of the storyteller's photographs, each with a caption. Place them INTO the story: wherever a passage clearly matches a photo's caption (the same people, event, place, or time), insert a line containing ONLY the marker [[PHOTO:N]] on its own line, between paragraphs, right after that passage. These marker lines ARE a required and allowed part of the output structure - include them even though the rest is prose.",
"Photo rules: use each photo number at most once; use only numbers that appear in the list; match by caption (names, dates, relationships); place as many as fit naturally throughout the chapters; if a photo has no clear home in the text, simply leave it out (leftover photos are collected into a Photographs section automatically). Never describe or mention the photo in the prose - output only the bare [[PHOTO:N]] marker line.",
"",
"Begin the memoir IMMEDIATELY. No preamble. No explanation of your process. No notes at the end. Just the memoir."
].join("\n");

// ----------------------------------------------------------------------------
// The COUPLE memoir system prompt — for two people recording together into one
// joint "our life together" book. Weaves two voices, keeps both perspectives
// when they differ, and attributes each memory to the right person using the
// diarized (Speaker A/B) transcript + the two names. Validated end-to-end.
// ----------------------------------------------------------------------------
const COUPLE_MEMOIR_SYSTEM_PROMPT = [
"You are a gifted memoir writer. Your job is to turn a COUPLE's recorded life story into a single finished memoir that reads like a warm, flowing STORY of two lives that became one — never a transcript, never a list of names and dates, and never a cold he-said/she-said interview. The two people recorded a series of audio clips together. Their words are transcribed below and each line is labeled with the speaker the system heard (\"Speaker A\" / \"Speaker B\"). They spoke in whatever order things came to them, finishing each other's sentences, correcting each other, and remembering the same moments differently. Shape what they said into a real book about THEIR LIFE TOGETHER, in THEIR OWN VOICES.",
"",
"FIRST, FIGURE OUT WHO IS WHO. You are told the two storytellers' names. The transcript labels are only 'Speaker A' and 'Speaker B' — you must map each label to the right name using context (who is called 'my wife'/'my husband', who is addressed by name, who tells which stories). Once you are confident, attribute their words to the correct person by NAME. If you truly cannot tell which of the two said something, attribute it to both of them together ('they', 'the two of them') rather than guessing wrong. NEVER put words in the wrong person's mouth.",
"",
"THREE UNBREAKABLE PRINCIPLES:",
"1. CHAPTERS FIT THIS SHARED LIFE. Do NOT use a fixed template. Read everything first and divide it into the chapters that fit THIS couple. The spine of the book is their life TOGETHER — how they met, courting, the wedding, building a home, children, the hard times and the good years, and who they are now. Where each person told a bit of their OWN early life (before they met), you may give that a short early chapter each, but keep the heart of the book on the life they built together. Give each chapter an evocative, specific title that carries a bit of the story. End with a short reflective closing chapter.",
"2. THEIR OWN VOICES — TWO OF THEM. Keep each person's exact vocabulary, idioms, rhythm, and level of formality; the two of them do not sound identical, and the book should let each voice come through. Weave the two voices into one flowing narrative — sometimes telling a shared moment in the third person ('They were married in the spring of 1961'), sometimes letting one of them tell it in their own words ('Nancy still laughs about the cake'), and — this is the charm of a couple's book — WHEN THEY REMEMBER THE SAME EVENT DIFFERENTLY, KEEP BOTH memories side by side ('Bill swears the band played too loud; Nancy only remembers dancing'). Never flatten two viewpoints into one, and never invent agreement they didn't express.",
"3. STRICTLY THEIR OWN WORDS — smoothed, never invented. This is the firm line and it is absolute. You MAY: reorder and group what they said, connect fragments into flowing paragraphs, trim filler/repetition/false starts, fix grammar, repair garbled spoken sentences so each reads smoothly, correct obvious transcription errors (especially garbled names), and attribute each memory to the right person. You MAY NOT: invent a memory, scene, place, event, feeling, or line of dialogue; add sensory details they never mentioned; assign feelings they did not express; put a story in the wrong person's mouth; or fill a gap with a plausible-sounding fact or date. Every sentence must be something one of them ACTUALLY TOLD US — just told better. Preserve their uncertainty ('around 1962' stays 'around 1962'); never fabricate certainty.",
"",
"HOW TO WRITE IT:",
"- OPEN ON A VIVID, REAL SHARED MEMORY — ideally the moment they met or a scene that captures the two of them — never on birth dates or genealogy. Find the most evocative TRUE thing they said and lead the whole book with it.",
"- Within each chapter, put things in a natural order (usually chronological) and connect the fragments into flowing paragraphs, using only the lightest transitions.",
"- Attribute naturally and often, so the reader always knows whose memory this is: 'Bill remembers…', 'To Nancy, it was…', 'The way she tells it…', 'He still says…'. Use their first names, not 'Speaker A'.",
"- Tell each memory as a little scene when they gave it that shape. Do not flatten a good story into a bare fact.",
"- WEAVE dates, places, and names naturally into the prose. Do NOT pile them into lists.",
"- Combine multiple recordings about the same topic into ONE coherent passage; never repeat the same anecdote twice (unless the two of them tell it differently — then hold both).",
"- Render painful memories honestly but gently, keeping the couple's own restraint. Never force emotion they did not express.",
"",
"GENEALOGY GOES AT THE BACK. Keep pure names-and-dates (each of their parents, grandparents, ancestors, birth years) OUT of the opening and body. If they gave genealogy, gather it into a single final chapter titled exactly '## Family Roots' at the very end — a short, clean summary of who came before EACH of them (a short paragraph for his side, a short paragraph for hers). The body of the book is THE LIFE ITSELF.",
"",
"PHOTOGRAPHS (when a photo list is provided in the user's message): place each photo next to the passage it best fits by inserting a line containing ONLY the marker [[PHOTO:N]] on its own line between paragraphs. Use each number at most once, only numbers in the list, match by caption; if a photo has no clear home, leave it out (leftovers are collected automatically). Never describe the photo in prose — only the bare marker line.",
"",
"OUTPUT FORMAT — return ONLY clean Markdown, nothing else (no preamble, no notes). Use this structure:",
"",
"# The Life and Times of [First name] and [First name]",
"",
"## [An evocative chapter title]",
"[flowing prose]",
"",
"## [The next evocative chapter title]",
"[flowing prose]",
"",
"... as many chapters as this shared life needs ...",
"",
"## Reflections",
"[a short closing, in their own looking-back — what they built, what they'd say to the family]",
"",
"## Family Roots",
"[include ONLY if they gave genealogy; a short clean summary of each of their parents/grandparents/ancestors and years]",
"",
"If they simply did not talk about some part of life, do NOT force a chapter and do NOT write filler — just leave it out.",
"",
"Begin the memoir IMMEDIATELY. No preamble. No explanation. No notes at the end. Just the memoir."
].join("\n");

// ----------------------------------------------------------------------------
// Top-level orchestrator. Throws on any error; caller decides how to handle.
// ----------------------------------------------------------------------------
async function runCleanupPipeline(customerId) {
  const customer = await db.queryOne(
    'SELECT id, email, name, access_token, follow_up_done, is_couple, partner_name FROM customers WHERE id = $1',
    [customerId]
  );
  if (!customer) throw new Error('Customer not found: ' + customerId);

  console.log('[cleanup] Starting pipeline for ' + customer.name + ' (' + customer.id + ')');

  // 1. Mark processing
  await db.query("UPDATE customers SET status = 'processing' WHERE id = $1", [customerId]);

  try {
    // 2. Transcribe any recordings that aren't transcribed yet
    const { rows: recordings } = await db.query(
      `SELECT id, storage_key, original_filename, transcript, transcript_status
       FROM recordings WHERE customer_id = $1 ORDER BY created_at ASC`,
      [customerId]
    );
    if (recordings.length === 0) throw new Error('No recordings to process.');

    console.log('[cleanup] Found ' + recordings.length + ' recordings');

    for (const r of recordings) {
      if (r.transcript && r.transcript_status === 'completed') continue;
      console.log('[cleanup] Transcribing recording ' + r.id);
      try {
        await db.query("UPDATE recordings SET transcript_status = 'transcribing' WHERE id = $1", [r.id]);
        const transcript = await transcribeFromR2(r.storage_key, customer.is_couple ? { speakerLabels: true, speakersExpected: 2 } : {});
        await db.query(
          `UPDATE recordings SET transcript = $1, transcript_status = 'completed' WHERE id = $2`,
          [transcript, r.id]
        );
        r.transcript = transcript;
        r.transcript_status = 'completed';
      } catch (err) {
        await db.query(
          `UPDATE recordings SET transcript_status = 'error', transcript_error = $1 WHERE id = $2`,
          [err.message, r.id]
        );
        throw new Error('Transcription failed for recording ' + r.id + ': ' + err.message);
      }
    }

    // 3. Polish via Claude
    console.log('[cleanup] Calling Claude to organize and polish');
    // Follow-up ANSWER recordings are handled separately (woven in as Q&A), so
    // keep them OUT of the main transcript stream.
    const { rows: fqRows } = await db.query(
      'SELECT id, question, sort_order, answer_recording_id FROM follow_up_questions WHERE customer_id = $1 ORDER BY sort_order ASC',
      [customerId]
    );
    const recById = {}; recordings.forEach(function (r) { recById[r.id] = r; });
    const answerRecIds = new Set(fqRows.filter(function (q) { return q.answer_recording_id; }).map(function (q) { return q.answer_recording_id; }));
    const mainRecordings = recordings.filter(function (r) { return !answerRecIds.has(r.id); });
    const combined = mainRecordings.map((r, i) =>
      '[RECORDING ' + (i + 1) + ' — ' + (r.original_filename || 'untitled') + ']\n' +
      (r.transcript || '(no transcript)')
    ).join('\n\n');
    // Q&A pairs the storyteller has already answered (question + spoken answer transcript).
    const answeredQA = fqRows
      .filter(function (q) { return q.answer_recording_id && recById[q.answer_recording_id]; })
      .map(function (q) { return { question: q.question, answer: (recById[q.answer_recording_id].transcript || '').trim() }; })
      .filter(function (qa) { return qa.answer; });
    // Gather the customer's photographs (metadata + bytes) so they can be
    // placed inside the memoir alongside the stories they belong to.
    const { rows: photoRows } = await db.query(
      `SELECT id, storage_key, caption, content_type, original_filename
       FROM photos WHERE customer_id = $1 ORDER BY created_at ASC`,
      [customerId]
    );
    const photos = [];
    for (const ph of photoRows) {
      try {
        ph.buffer = await storage.getObjectBuffer(ph.storage_key);
        // Legacy HEIC already in storage: convert to JPEG so it embeds.
        if (ph.buffer && isHeic(ph.buffer, ph.original_filename, ph.content_type)) {
          try {
            const heicConvert = require('heic-convert');
            ph.buffer = Buffer.from(await heicConvert({ buffer: ph.buffer, format: 'JPEG', quality: 0.9 }));
            ph.content_type = 'image/jpeg';
            ph.original_filename = (ph.original_filename || 'photo').replace(/\.(heic|heif)$/i, '') + '.jpg';
          } catch (e) {
            console.error('[cleanup] HEIC conversion failed for ' + ph.id + ': ' + e.message);
          }
        }
        // Bake in EXIF orientation so portrait photos aren't embedded sideways.
        if (ph.buffer) ph.buffer = await autoOrient(ph.buffer, ph.content_type, ph.original_filename);
      } catch (e) {
        ph.buffer = null;
        console.error('[cleanup] could not load photo ' + ph.id + ': ' + e.message);
      }
      photos.push(ph);
    }
    console.log('[cleanup] Loaded ' + photos.length + ' photo(s) for placement');

    // For a couple, the "book name" is both first names, and generation runs
    // through the two-voice writer on the diarized transcript.
    const bookName = customer.is_couple
      ? ((customer.name || '') + (customer.partner_name ? ' & ' + customer.partner_name : ''))
      : customer.name;
    let memoirMarkdown = customer.is_couple
      ? await polishCoupleWithClaude(customer.name, customer.partner_name, combined, photos, answeredQA)
      : await polishWithClaude(customer.name, combined, photos, answeredQA);

    // 3b. QUALITY PASS — strict AI proofread that removes obvious mechanical
    //     errors (duplicated passages, repeated photo markers, cut-off text, an
    //     inconsistently spelled name) BEFORE the customer ever sees the draft.
    //     Conservative: never rewrites or changes facts. NON-FATAL — any failure
    //     (or a suspiciously short result) keeps the original memoir, so a
    //     proofreader hiccup can never gut or block a book.
    try {
      memoirMarkdown = await qualityPassWithClaude(memoirMarkdown);
      console.log('[cleanup] quality pass complete for ' + customer.name);
    } catch (e) {
      console.error('[cleanup] quality pass skipped (kept original memoir): ' + e.message);
    }

    // 4. Render to .docx (with photos placed inline)
    console.log('[cleanup] Rendering .docx');
    const docxBuffer = await renderMemoirDocx(memoirMarkdown, photos);

    // 5. Upload .docx to R2
    const docxKey = 'customers/' + customer.id + '/drafts/v1-' + Date.now() + '.docx';
    await storage.uploadObject(
      docxKey,
      docxBuffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    // 5b. Render the print-ready interior + cover PDFs for Lulu (best-effort).
    let interiorPdfKey = null, pageCount = null, coverPdfKey = null;
    try {
      const pdf = await renderAndUploadInteriorPdf(customerId, memoirMarkdown, photos, 'v1');
      interiorPdfKey = pdf.key; pageCount = pdf.pageCount;
      console.log('[cleanup] interior PDF rendered (' + pageCount + ' pages)');
    } catch (e) {
      console.error('[cleanup] interior PDF failed (non-fatal): ' + e.message);
    }
    try {
      const cov = await renderAndUploadCoverPdf(customerId, bookName, pageCount || 24, 'cover-v1');
      coverPdfKey = cov.key;
      console.log('[cleanup] cover PDF rendered (spine ' + cov.spineIn.toFixed(3) + ' in)');
    } catch (e) {
      console.error('[cleanup] cover PDF failed (non-fatal): ' + e.message);
    }

    // 6. Save draft row
    const draft = await db.queryOne(
      `INSERT INTO drafts (customer_id, version, markdown_content, docx_storage_key, status, interior_pdf_key, cover_pdf_key, page_count)
       VALUES ($1, 1, $2, $3, 'ready_for_review', $4, $5, $6)
       ON CONFLICT (customer_id, version) DO UPDATE
       SET markdown_content = EXCLUDED.markdown_content,
           docx_storage_key = EXCLUDED.docx_storage_key,
           status = EXCLUDED.status,
           interior_pdf_key = EXCLUDED.interior_pdf_key,
           cover_pdf_key = EXCLUDED.cover_pdf_key,
           page_count = EXCLUDED.page_count,
           created_at = NOW()
       RETURNING id`,
      [customerId, memoirMarkdown, docxKey, interiorPdfKey, coverPdfKey, pageCount]
    );

    // 7. FIRST DRAFT ONLY: ask the storyteller a few gentle follow-up questions
    //    to enrich thin stories, then pause for their spoken answers. On the
    //    re-run (answers present) or if they skipped, we finalize instead.
    // Follow-up questions are single-storyteller for now; couples skip straight
    // to draft-ready in v1 (couple follow-ups can come later).
    if (!customer.is_couple && !customer.follow_up_done && answeredQA.length === 0) {
      let questions = [];
      try { questions = await generateFollowUpQuestions(combined, memoirMarkdown); }
      catch (e) { console.error('[cleanup] follow-up question generation failed: ' + e.message); }
      if (questions.length > 0) {
        for (let i = 0; i < questions.length; i++) {
          await db.query('INSERT INTO follow_up_questions (customer_id, question, sort_order) VALUES ($1, $2, $3)', [customerId, questions[i], i]);
        }
        await db.query("UPDATE customers SET status = 'follow_up' WHERE id = $1", [customerId]);
        try {
          await emailCustomerFollowUp(customer);
        } catch (e) {
          // The customer never got their "answer a few questions" invite, so they
          // won't come back on their own — a silent strand. Tell Ken so he can
          // reach out or finalize the draft as-is from the dashboard.
          console.error('[cleanup] could not email customer follow-up: ' + e.message);
          try { await emailAdminFollowUpUndelivered(customer, e.message); }
          catch (e2) { console.error('[cleanup] also could not alert Ken about it: ' + e2.message); }
        }
        console.log('[cleanup] First draft done; generated ' + questions.length + ' follow-up question(s), awaiting answers.');
        return draft.id; // stop here — draft saved but not delivered until they answer or skip
      }
      // no questions worth asking -> fall through and finalize
    }

    // 8. FINALIZE: the book is ready — hand it straight to the CUSTOMER to read
    //    and approve. No manual review gate: Ken is a one-man shop, so the AI
    //    delivers to the storyteller directly. The draft stays 'ready_for_review'
    //    and the customer sits at 'draft_ready' — the state whose story page shows
    //    the memoir PLUS the "tell me a change" and "approve" buttons. When they
    //    approve, the existing auto-print flow runs (customers/approve-book ->
    //    'approved' -> Lulu). Ken never has to touch it.
    //    NOTE: do NOT set status 'delivered' here — that is a terminal state with
    //    NO approve button (it's what Ken's manual "Approve and Send" produces),
    //    so finishing into 'delivered' would strand the customer with no way to
    //    approve their own book.
    await db.query("UPDATE customers SET status = 'draft_ready', follow_up_done = TRUE WHERE id = $1", [customerId]);

    // Tell the CUSTOMER their book is ready to read and approve. A mail hiccup
    // must NEVER roll a finished draft back to 'error' — it is built and saved.
    // If the email fails we log it and alert Ken so he can send the link by hand.
    try {
      await emailCustomerDelivered(customer);
    } catch (e) {
      console.error('[cleanup] draft READY but the customer email failed (draft stands): ' + e.message);
      try { await emailAdminDeliveryEmailFailed(customer, e.message); }
      catch (e2) { console.error('[cleanup] also could not alert Ken about the failed email: ' + e2.message); }
    }

    // FYI to Ken — informational only, no action needed; the book is already
    // with the customer to read and approve.
    try {
      await emailAdminDelivered(customer, draft.id);
    } catch (e) {
      console.error('[cleanup] could not send Ken the FYI (harmless): ' + e.message);
    }

    console.log('[cleanup] Pipeline complete — draft READY and sent to ' + customer.name + ' to read and approve — draft ' + draft.id);
    return draft.id;
  } catch (err) {
    console.error('[cleanup] Pipeline FAILED for customer ' + customerId, err);
    await db.query("UPDATE customers SET status = 'error' WHERE id = $1", [customerId]).catch(()=>{});
    await emailAdminError(customer, err.message).catch((e) => console.error('[cleanup] could not email Ken:', e));
    throw err;
  }
}

// ----------------------------------------------------------------------------
// Transcribe an R2-stored audio file via AssemblyAI.
// AssemblyAI accepts a URL or raw bytes upload — we use the raw bytes path
// since the R2 file is private.
// ----------------------------------------------------------------------------
async function transcribeFromR2(storageKey, opts) {
  opts = opts || {};
  const audioBuffer = await storage.getObjectBuffer(storageKey);

  // 1. Upload bytes to AssemblyAI
  const upResp = await fetchWithRetry('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { 'Authorization': process.env.ASSEMBLYAI_API_KEY },
    body: audioBuffer,
  }, 'AAI upload');
  if (!upResp.ok) throw new Error('AAI upload failed: ' + await upResp.text());
  const { upload_url } = await upResp.json();

  // 2. Submit for transcription. For couples we turn on speaker diarization so
  //    the two-voice memoir writer can tell who said what.
  const submitBody = {
    audio_url: upload_url,
    language_code: 'en',
    speech_models: ['universal-2'],
  };
  if (opts.speakerLabels) {
    submitBody.speaker_labels = true;
    if (opts.speakersExpected) submitBody.speakers_expected = opts.speakersExpected;
  }
  const subResp = await fetchWithRetry('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      'Authorization': process.env.ASSEMBLYAI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(submitBody),
  }, 'AAI submit');
  if (!subResp.ok) throw new Error('AAI submit failed: ' + await subResp.text());
  const { id: tid } = await subResp.json();

  // 3. Poll until done (longer recordings take longer — up to ~5 minutes for an hour of audio)
  // We poll for up to 10 minutes.
  for (let i = 0; i < 150; i++) {
    await sleep(4000);
    const stResp = await fetchWithRetry('https://api.assemblyai.com/v2/transcript/' + tid, {
      headers: { 'Authorization': process.env.ASSEMBLYAI_API_KEY },
    }, 'AAI poll');
    // A transient bad response during polling shouldn't kill the whole build —
    // just skip this tick and check again in 4s (we poll for up to 10 minutes).
    let data;
    try { data = await stResp.json(); } catch (e) { continue; }
    if (data.status === 'completed') {
      // When diarization is on, return a speaker-labeled transcript so the
      // couple writer can attribute lines. Fall back to plain text otherwise.
      if (opts.speakerLabels && Array.isArray(data.utterances) && data.utterances.length) {
        return data.utterances
          .map(function (u) { return 'Speaker ' + (u.speaker || '?') + ': ' + (u.text || ''); })
          .join('\n');
      }
      return data.text || '';
    }
    if (data.status === 'error') throw new Error('AAI transcription error: ' + data.error);
  }
  throw new Error('Transcription timed out (10 minutes)');
}

// ----------------------------------------------------------------------------
// Send the combined transcripts to Claude, receive memoir Markdown.
// ----------------------------------------------------------------------------
async function polishWithClaude(customerName, combinedTranscripts, photos, answeredQA) {
  photos = photos || [];
  answeredQA = answeredQA || [];
  let photoBlock = '';
  if (photos.length) {
    photoBlock =
      "\n\n----\n\nThe storyteller also uploaded " + photos.length + " photograph(s), listed below by number with the caption they wrote. As you write the memoir, place each photo next to the part of the story it best fits by inserting a marker ON ITS OWN LINE in EXACTLY this form: [[PHOTO:N]] (for example [[PHOTO:3]]).\n" +
      "Rules for photo markers:\n" +
      "- Use each photo number AT MOST ONCE, and only numbers that appear in the list.\n" +
      "- Put the marker on its own line, between paragraphs, right after the sentence or story it relates to.\n" +
      "- Match using the caption (names, dates, relationships). If a photo has no clear home in the text, simply leave it out \u2014 leftover photos are added to a Photographs section automatically.\n" +
      "- Do NOT describe or mention the photo in the prose; only insert the marker line.\n\n" +
      "PHOTOS:\n" +
      photos.map(function (p, i) { return "Photo " + (i + 1) + ": " + (p.caption || '(no caption)'); }).join('\n');
  }
  let qaBlock = '';
  if (answeredQA.length) {
    qaBlock =
      "\n\n----\n\nAFTER a first draft, the storyteller was asked a few follow-up questions and gave these SPOKEN answers. Weave each answer into the relevant part of the story, in their own words, exactly like the rest of the memoir. Do NOT add a question-and-answer section, and follow the same firm rule: use only what they actually said.\n\n" +
      answeredQA.map(function (qa, i) { return "Follow-up " + (i + 1) + "\nQuestion we asked: " + qa.question + "\nTheir spoken answer: " + qa.answer; }).join("\n\n");
  }
  const userMsg =
    "Storyteller's name: " + customerName + "\n\n" +
    "Here are the transcripts of their recordings. Organize and polish them into the memoir per the rules above:\n\n" +
    combinedTranscripts + qaBlock + photoBlock;

  const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 16000,
      stream: true,
      system: MEMOIR_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!resp.ok) throw new Error('Claude API error: ' + await resp.text());
  const text = await readClaudeStream(resp);
  return text.trim();
}

// ----------------------------------------------------------------------------
// QUALITY PASS — a conservative AI proofread of the finished memoir, run BEFORE
// it ever reaches the customer. Fixes only obvious mechanical mistakes; never
// rewrites, restyles, or changes a fact. Streams (large output) like the memoir
// writer, so a big book can't hit the ~5-min headers timeout.
// ----------------------------------------------------------------------------
const QUALITY_PASS_SYSTEM_PROMPT = [
"You are a careful proofreader for a senior's finished memoir. You will receive the full memoir in Markdown. Your ONLY job is to fix OBVIOUS mechanical mistakes that slipped in, then return the WHOLE memoir again, otherwise completely unchanged.",
"",
"FIX these when they clearly occur:",
"- Duplicated content: the same story, paragraph, or sentence repeated. Keep the first, fullest occurrence and remove the near-exact repeat.",
"- A photo marker [[PHOTO:N]] that appears more than once for the same number N: keep the first, remove the duplicate(s).",
"- Text obviously cut off mid-sentence or mid-word, an accidentally doubled word (\"the the\"), or a stray leftover instruction/label that is clearly not part of the story.",
"- The SAME person's name spelled inconsistently: normalize it to the spelling used most often. Names only.",
"",
"NEVER do any of these:",
"- Do NOT rewrite, restyle, shorten, expand, reorder, re-title, or 'improve' anything. Every word you are not fixing must stay EXACTLY as it is, in the storyteller's own voice.",
"- Do NOT invent, add, or alter any fact, name, date, place, or detail.",
"- Do NOT resolve a contradiction by guessing. If two different dates or facts are given for the same thing, LEAVE BOTH exactly as they are — only the storyteller knows which is right.",
"- Keep every [[PHOTO:N]] marker line exactly where it is (except a true duplicate of the same N), and keep all headings and chapter titles exactly.",
"",
"If there is nothing obvious to fix, return the memoir completely unchanged. Return ONLY the full memoir in Markdown — no preamble, no notes, no explanation.",
].join("\n");

async function qualityPassWithClaude(memoirMarkdown) {
  const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 16000,
      stream: true,
      system: QUALITY_PASS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Here is the memoir to proofread:\n\n' + memoirMarkdown }],
    }),
  });
  if (!resp.ok) throw new Error('Claude API error (quality pass): ' + await resp.text());
  const cleaned = (await readClaudeStream(resp)).trim();
  // Safety net: never let the proofread deliver a gutted/truncated memoir. If it
  // comes back far shorter than the original, treat it as a failure so the
  // caller's try/catch keeps the original memoir untouched.
  if (!cleaned || cleaned.length < memoirMarkdown.length * 0.6) {
    throw new Error('quality-pass output too short (' + (cleaned ? cleaned.length : 0) + ' vs ' + memoirMarkdown.length + ')');
  }
  return cleaned;
}

// ----------------------------------------------------------------------------
// COUPLE version: two storytellers -> one joint memoir. Same photo/Q&A handling
// as the single-person writer, but uses the two-voice system prompt and passes
// both names plus the diarized (Speaker A/B) transcript.
// ----------------------------------------------------------------------------
async function polishCoupleWithClaude(name1, name2, combinedTranscripts, photos, answeredQA) {
  photos = photos || [];
  answeredQA = answeredQA || [];
  let photoBlock = '';
  if (photos.length) {
    photoBlock =
      "\n\n----\n\nThe couple also uploaded " + photos.length + " photograph(s), listed below by number with the caption they wrote. Place each photo next to the part of the story it best fits by inserting a marker ON ITS OWN LINE in EXACTLY this form: [[PHOTO:N]].\n" +
      "- Use each photo number AT MOST ONCE, and only numbers that appear in the list.\n" +
      "- Put the marker on its own line, between paragraphs, right after the story it relates to.\n" +
      "- Match using the caption. If a photo has no clear home, leave it out (leftovers are added to a Photographs section automatically).\n" +
      "- Do NOT describe the photo in prose; only insert the marker line.\n\n" +
      "PHOTOS:\n" +
      photos.map(function (p, i) { return "Photo " + (i + 1) + ": " + (p.caption || '(no caption)'); }).join('\n');
  }
  let qaBlock = '';
  if (answeredQA.length) {
    qaBlock =
      "\n\n----\n\nAFTER a first draft, the couple was asked a few follow-up questions and gave these SPOKEN answers. Weave each answer into the relevant part of the story, attributed to the right person, exactly like the rest of the memoir. Do NOT add a question-and-answer section, and follow the same firm rule: use only what they actually said.\n\n" +
      answeredQA.map(function (qa, i) { return "Follow-up " + (i + 1) + "\nQuestion we asked: " + qa.question + "\nTheir spoken answer: " + qa.answer; }).join("\n\n");
  }
  const userMsg =
    "The two storytellers are a couple. Their names are: " + (name1 || 'the first storyteller') + " and " + (name2 || 'the second storyteller') + ".\n\n" +
    "Here is the transcript of their recordings, each line labeled with the speaker the system heard. Figure out which of them is " + (name1 || 'the first') + " and which is " + (name2 || 'the second') + " from context, then organize and polish everything into their joint memoir per the rules above:\n\n" +
    combinedTranscripts + qaBlock + photoBlock;

  const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 16000,
      stream: true,
      system: COUPLE_MEMOIR_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!resp.ok) throw new Error('Claude API error (couple): ' + await resp.text());
  const text = await readClaudeStream(resp);
  return text.trim();
}

// ----------------------------------------------------------------------------
// Render the Markdown memoir to a .docx Buffer.
// The prompt produces a predictable structure:
//   # Title
//   ## Section heading
//   paragraph...
//   paragraph...
//   ## Next section
//   ...
// We parse line-by-line (no nested markdown beyond what we asked for) and emit
// docx paragraphs accordingly.
// ----------------------------------------------------------------------------
// Detect HEIC/HEIF by extension, mime, or ftyp brand magic.
function isHeic(buffer, name, mime) {
  const n = (name || '').toLowerCase(), m = (mime || '').toLowerCase();
  if (n.endsWith('.heic') || n.endsWith('.heif')) return true;
  if (m.includes('heic') || m.includes('heif')) return true;
  if (buffer && buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12).toLowerCase();
    if (['heic','heix','hevc','heim','heis','hevm','hevs','mif1','msf1'].includes(brand)) return true;
  }
  return false;
}

// Physically apply a JPEG's EXIF orientation (bake the rotation into the pixels)
// so portrait phone photos are not embedded sideways. No-op for non-JPEG or
// already-upright images.
async function autoOrient(buffer, contentType, filename) {
  const isJpeg = /jpe?g/i.test(contentType || '') || /\.jpe?g$/i.test(filename || '') ||
                 (buffer && buffer.length > 2 && buffer[0] === 0xFF && buffer[1] === 0xD8);
  if (!isJpeg) return buffer;
  try {
    const sharp = require('sharp');
    const meta = await sharp(buffer).metadata();
    if (meta.orientation && meta.orientation > 1) {
      return await sharp(buffer).rotate().jpeg({ quality: 90 }).toBuffer();
    }
  } catch (e) {
    console.error('[cleanup] auto-orient skipped: ' + e.message);
  }
  return buffer;
}

// Map an uploaded photo to a docx-supported image type, or null if unsupported.
function docxImageType(p) {
  const TYPE_MAP = { jpg: 'jpg', jpeg: 'jpg', png: 'png', gif: 'gif', bmp: 'bmp' };
  const ext = ((p.original_filename || '').split('.').pop() || '').toLowerCase();
  const ct = ((p.content_type || '').split('/').pop() || '').toLowerCase();
  return TYPE_MAP[ext] || TYPE_MAP[ct] || null;
}

// Produce the docx paragraphs for one photo: the image (scaled to fit) plus its
// caption. Unsupported formats (e.g. HEIC) degrade to a small note + caption so
// nothing is ever silently dropped.
function photoParagraphs(p) {
  const out = [];
  const type = docxImageType(p);
  const MAXW = 384; // ~4 inches wide inline
  if (type && p.buffer) {
    let w = MAXW, h = MAXW;
    try {
      const dim = imageSize(p.buffer);
      if (dim && dim.width && dim.height) {
        const scale = Math.min(MAXW / dim.width, 1);
        w = Math.round(dim.width * scale);
        h = Math.round(dim.height * scale);
      }
    } catch (e) { /* fall back to square */ }
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 160, after: 40 },
      children: [new ImageRun({ data: p.buffer, type: type, transformation: { width: w, height: h } })],
    }));
  } else {
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 160, after: 40 },
      children: [new TextRun({ text: '[ Photograph ]', italics: true, size: 22, color: '8B5A2B' })],
    }));
  }
  if (p.caption) {
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 200 },
      children: [new TextRun({ text: p.caption, italics: true, size: 22, color: '5A4A3A' })],
    }));
  }
  return out;
}

// Render the print-ready interior PDF for Lulu and upload it to R2. Returns
// { key, pageCount }. Best-effort: a PDF failure must not break draft creation
// (the .docx is still produced), so callers wrap this in try/catch.
async function renderAndUploadInteriorPdf(customerId, markdown, photos, tag) {
  const { buffer, pageCount } = await bookPdf.renderMemoirPdf(markdown, photos);
  const key = 'customers/' + customerId + '/print/' + (tag || 'interior') + '-' + Date.now() + '.pdf';
  await storage.uploadObject(key, buffer, 'application/pdf');
  return { key, pageCount };
}

// Render the wraparound cover for this book (spine sized to the page count) and
// upload it to R2. Returns { key, spineIn }. The exact spine is refined against
// Lulu's cover-dimensions API at order time; this uses the validated formula.
async function renderAndUploadCoverPdf(customerId, name, pageCount, tag) {
  const { buffer, spineIn } = await coverPdf.renderCoverPdf({ name: name || 'Your Name', pageCount });
  const key = 'customers/' + customerId + '/print/' + (tag || 'cover') + '-' + Date.now() + '.pdf';
  await storage.uploadObject(key, buffer, 'application/pdf');
  return { key, spineIn };
}

async function renderMemoirDocx(markdown, photos) {
  photos = photos || [];
  const byIdx = {};
  photos.forEach(function (p, i) { byIdx[i + 1] = p; });
  const placed = new Set();
  const lines = markdown.split('\n');
  const children = [];

  const BROWN = '8B5A2B';
  const DARK = '2A2520';

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const photoMarker = line.match(/^\[\[PHOTO:(\d+)\]\]$/);
    if (photoMarker) {
      const idx = parseInt(photoMarker[1], 10);
      const p = byIdx[idx];
      if (p && !placed.has(idx)) { placed.add(idx); photoParagraphs(p).forEach(function (x) { children.push(x); }); }
      continue;
    }
    if (!line) continue;

    if (line.startsWith('# ')) {
      children.push(new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 360 },
        children: [new TextRun({ text: line.slice(2), bold: true, size: 48, color: BROWN })],
      }));
    } else if (line.startsWith('## ')) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 180 },
        children: [new TextRun({ text: line.slice(3), bold: true, size: 32, color: BROWN })],
      }));
    } else {
      // Handle italic-wrapped lines (like "*The storyteller did not record...*")
      const isItalic = line.startsWith('*') && line.endsWith('*') && line.length > 2;
      const text = isItalic ? line.slice(1, -1) : line;
      children.push(new Paragraph({
        spacing: { before: 0, after: 140 },
        children: [new TextRun({
          text: text,
          italics: isItalic,
          size: 24,
          color: DARK,
        })],
      }));
    }
  }

  // Any photos the model didn't place go into a Photographs section at the end,
  // so a customer's picture is never lost.
  const leftover = photos.filter(function (p, i) { return !placed.has(i + 1); });
  if (leftover.length) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 480, after: 180 },
      children: [new TextRun({ text: 'Photographs', bold: true, size: 32, color: '8B5A2B' })],
    }));
    leftover.forEach(function (p) { photoParagraphs(p).forEach(function (x) { children.push(x); }); });
  }

  const doc = new Document({
    creator: 'BCS Memory Box',
    styles: {
      default: { document: { run: { font: 'Georgia', size: 24 } } },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },           // US Letter
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children,
    }],
  });

  return await Packer.toBuffer(doc);
}

// ----------------------------------------------------------------------------
// Email notifications to Ken (admin)
// ----------------------------------------------------------------------------
async function emailAdminDraftReady(customer, draftId) {
  const subject = 'Memory Box draft ready for ' + customer.name;
  const adminLink = 'https://www.bcsmemorybox.com/admin.html';
  const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#8b5a2b;">Draft ready for review</h2>' +
'<p>The automated cleanup pipeline finished a draft for <strong>' + escapeHtml(customer.name) + '</strong> (' + escapeHtml(customer.email) + ').</p>' +
'<p>Open the admin dashboard, click into their record, read through the draft, edit anything you want, then click Approve and Send.</p>' +
'<p><a href="' + adminLink + '" style="background:#8b5a2b;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Open admin dashboard</a></p>' +
'<p style="color:#888;font-size:13px;">Draft ID: ' + draftId + '</p>' +
'</div>';

  return sendEmail('kbakerbcs1@gmail.com', subject, html);
}

// The customer-facing "your book is ready" email, sent automatically when the
// pipeline finishes a draft. Mirrors the manual Approve-and-Send email in
// routes/admin.js so both paths give the storyteller the same experience.
async function emailCustomerDelivered(customer) {
  const portalUrl = 'https://www.bcsmemorybox.com/yourstory.html?token=' + encodeURIComponent(customer.access_token);
  const subject = 'Your Memory Box memoir is ready';
  const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.65;color:#2a2520;background:#fff;padding:32px;border-radius:8px;">' +
'<p>Hi ' + escapeHtml(customer.name) + ',</p>' +
'<p>Wonderful news — your memoir is ready to read. Everything you recorded has been woven together into your book, and it is waiting for you on your story page.</p>' +
'<p style="margin-top:28px;">' +
'<a href="' + portalUrl + '" style="background:#8b5a2b;color:#fff;padding:14px 28px;text-decoration:none;border-radius:4px;display:inline-block;font-family:Georgia,serif;font-weight:bold;">Open your memoir</a>' +
'</p>' +
'<p style="font-size:15px;color:#6b5d4f;margin-top:6px;">If the button above does not open, copy and paste this web address into your web browser:<br>' +
'<a href="' + portalUrl + '" style="color:#8b5a2b;word-break:break-all;">' + portalUrl + '</a></p>' +
'<p>Please read it through. From your story page you can download the Word document to keep for your family.</p>' +
'<p>If anything reads wrong, or you would like something changed, just click <strong>Request a revision</strong> on that same page and tell me in your own words — your purchase includes two rounds of revisions. When it reads just the way you want, click <strong>Approve</strong> and I will send it off to be printed as your hardcover book.</p>' +
'<p style="margin-top:28px;">— Ken Baker<br>BCS Memory Box</p>' +
'</div>';
  return sendEmail(customer.email, subject, html);
}

// Heads-up to Ken that a book auto-delivered. Informational only — no action.
async function emailAdminDelivered(customer, draftId) {
  const subject = customer.name + "'s book is done — auto-delivered to the customer";
  const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#8b5a2b;">Book delivered — no action needed</h2>' +
'<p>The pipeline finished <strong>' + escapeHtml(customer.name) + '</strong>\'s memoir (' + escapeHtml(customer.email) + ') and <strong>sent it straight to them</strong> to read and approve. You do not need to do anything.</p>' +
'<p>They will read it, request any revisions in their own words, and approve when it reads right — the approved book prints automatically.</p>' +
'<p style="color:#888;font-size:13px;">Heads-up only. Draft ID: ' + draftId + '</p>' +
'</div>';
  return sendEmail('kbakerbcs1@gmail.com', subject, html);
}

// The one case where Ken DOES need to step in: the book delivered fine but the
// customer's "it's ready" email bounced, so they don't know to come read it.
async function emailAdminDeliveryEmailFailed(customer, reason) {
  const subject = 'ACTION NEEDED: ' + customer.name + "'s book is ready but the email to them failed";
  const portalUrl = 'https://www.bcsmemorybox.com/yourstory.html?token=' + encodeURIComponent(customer.access_token);
  const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#b4432a;">Delivery email failed — please resend the link</h2>' +
'<p><strong>' + escapeHtml(customer.name) + '</strong> (' + escapeHtml(customer.email) + ') has a finished, delivered book, but the email telling them it is ready <strong>did not send</strong>, so they don\'t know to come read it.</p>' +
'<p>Please send them their story-page link by hand:<br><a href="' + portalUrl + '" style="color:#8b5a2b;word-break:break-all;">' + portalUrl + '</a></p>' +
'<p style="color:#7a726a;font-size:13px;">Reason: ' + escapeHtml(reason || 'unknown') + '</p>' +
'</div>';
  return sendEmail('kbakerbcs1@gmail.com', subject, html);
}

async function emailAdminError(customer, errorMessage) {
  const subject = 'Memory Box pipeline ERROR for ' + (customer && customer.name || 'customer');
  const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#c0392b;">Cleanup pipeline failed</h2>' +
'<p>The pipeline failed for ' + escapeHtml((customer && customer.name) || 'a customer') + '.</p>' +
'<p><strong>Error:</strong> ' + escapeHtml(errorMessage) + '</p>' +
'<p>Their customer status is now set to <code>error</code>. You can investigate in the admin dashboard, fix the issue, and retry from there.</p>' +
'</div>';
  return sendEmail('kbakerbcs1@gmail.com', subject, html);
}

// A customer's first draft is ready, but we couldn't email them the "answer a
// few questions" follow-up invite — so they won't return on their own. Tell Ken
// so nobody is silently stranded in the follow-up state.
async function emailAdminFollowUpUndelivered(customer, reason) {
  const subject = 'Memory Box: couldn’t reach ' + (customer && customer.name || 'a customer') + ' for follow-up';
  const adminLink = 'https://www.bcsmemorybox.com/admin.html';
  const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#c0392b;">A follow-up email didn’t send</h2>' +
'<p><strong>' + escapeHtml((customer && customer.name) || 'A customer') + '</strong> (' + escapeHtml((customer && customer.email) || '') + ') has a finished first draft, but the email inviting them to answer a few follow-up questions <strong>failed to send</strong>, so they won’t know to come back.</p>' +
'<p style="color:#7a726a;font-size:13px;">Reason: ' + escapeHtml(reason || 'unknown') + '</p>' +
'<p>You can reach out to them directly, or open their record and finalize/deliver the draft as-is.</p>' +
'<p><a href="' + adminLink + '" style="background:#8b5a2b;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Open admin dashboard</a></p>' +
'</div>';
  return sendEmail('kbakerbcs1@gmail.com', subject, html);
}

// After a restart we reset any interrupted voice-revisions; let Ken know which
// customers were affected (they've been unblocked to try their change again).
async function emailAdminInterruptedRevisions(names) {
  const subject = 'Memory Box: recovered ' + names.length + ' interrupted change' + (names.length === 1 ? '' : 's') + ' after a restart';
  const list = names.map(function (n) { return '<li>' + escapeHtml(n) + '</li>'; }).join('');
  const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#8b5a2b;">A restart interrupted some changes — now recovered</h2>' +
'<p>The server restarted while ' + names.length + ' customer voice-change' + (names.length === 1 ? ' was' : 's were') + ' being applied. I’ve reset ' + (names.length === 1 ? 'it' : 'them') + ' so the customer can simply try the change again — nothing was lost:</p>' +
'<ul>' + list + '</ul>' +
'<p style="color:#7a726a;font-size:13px;">No action needed unless a customer says a change didn’t take — then ask them to say it once more.</p>' +
'</div>';
  return sendEmail('kbakerbcs1@gmail.com', subject, html);
}

async function sendEmail(to, subject, html) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // Notifications to Ken show sender "Bullet"; customer mail stays branded.
      from: to === 'kbakerbcs1@gmail.com'
        ? 'Bullet <ops@bcsmemorybox.com>'
        : 'BCS Memory Box <ops@bcsmemorybox.com>',
      to: to,
      reply_to: to === 'kbakerbcs1@gmail.com' ? 'kbakerbcs1@gmail.com' : 'hello@bcsmemorybox.com',
      subject: subject,
      html: html,
    }),
  });
  if (!resp.ok) throw new Error('Resend error: ' + await resp.text());
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Resilient fetch for the outside services the memoir pipeline depends on
// (AssemblyAI transcription, Anthropic writing). A single transient blip — a
// 429 "too busy" or a 5xx/network hiccup — used to abort a customer's ENTIRE
// book build (audit H4). This retries up to 3 times with a short backoff
// (1s, then 2s) on exactly those transient conditions, then returns the final
// response so the caller's existing `if (!resp.ok) throw` still handles a real,
// persistent failure. A definite answer (2xx, or a 4xx like "bad request")
// returns immediately — we only retry things that are plausibly temporary.
// The request bodies here are buffers/JSON strings (safe to resend).
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
async function fetchWithRetry(url, options, label) {
  const MAX = 3;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (resp.ok || !RETRYABLE_STATUS.has(resp.status) || attempt === MAX) return resp;
      console.warn('[retry] ' + (label || url) + ' got HTTP ' + resp.status
        + ' (attempt ' + attempt + '/' + MAX + ') — retrying…');
    } catch (e) {
      if (attempt === MAX) throw e;
      console.warn('[retry] ' + (label || url) + ' network error: ' + e.message
        + ' (attempt ' + attempt + '/' + MAX + ') — retrying…');
    }
    await sleep(1000 * Math.pow(2, attempt - 1)); // 1s, then 2s
  }
}

// Read an Anthropic STREAMING (SSE) response and return the full assistant text.
// The big memoir/revision generations are streamed (stream:true) because a
// non-streaming request keeps the connection open with NO response headers until
// Claude finishes — and a large book (e.g. Kelly's 11 recordings) can run past
// Node's ~5-minute headers timeout, throwing UND_ERR_HEADERS_TIMEOUT ("fetch
// failed") and killing the whole pipeline. Streaming returns headers immediately
// and the text arrives in deltas, so there is no long silent wait to time out.
async function readClaudeStream(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch (e) { continue; }
      if (evt.type === 'content_block_delta' && evt.delta && typeof evt.delta.text === 'string') {
        text += evt.delta.text;
      } else if (evt.type === 'error') {
        throw new Error('Claude stream error: ' + JSON.stringify(evt.error || evt));
      }
    }
  }
  return text;
}

// ----------------------------------------------------------------------------
// Safety net ("reaper"): detect customers stuck in 'processing' — a pipeline
// that died silently (e.g. the server restarted mid-run) — and email Ken so no
// paying customer is ever left waiting with no draft and no error. The
// customers.updated_at trigger records when 'processing' began, so "processing
// for too long" is easy to spot. Alerts once per customer per process lifetime
// (it re-checks after a restart, which is exactly when jobs die). Ken retries
// from the admin dashboard. Threshold is generous so a legit long batch of
// recordings doesn't cry wolf.
// ----------------------------------------------------------------------------
const STUCK_MINUTES = 60;
const _alertedStuck = new Set();

async function emailAdminStuck(customer) {
  const subject = 'Memory Box: a memoir may be STUCK for ' + (customer && customer.name || 'a customer');
  const adminLink = 'https://www.bcsmemorybox.com/admin.html';
  const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#c0392b;">A memoir has been processing too long</h2>' +
'<p><strong>' + escapeHtml((customer && customer.name) || 'A customer') + '</strong> (' + escapeHtml((customer && customer.email) || '') + ') has been in <code>processing</code> for over ' + STUCK_MINUTES + ' minutes.</p>' +
'<p>It may be stuck (for example, the server restarted mid-run) &mdash; or it could just be a very large batch of recordings still finishing. Please open the admin dashboard to check, and if it is stuck, retry it from there.</p>' +
'<p><a href="' + adminLink + '" style="background:#8b5a2b;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Open admin dashboard</a></p>' +
'</div>';
  return sendEmail('kbakerbcs1@gmail.com', subject, html);
}

async function checkStuckCustomers() {
  if (!db.enabled) return;
  let result;
  try {
    result = await db.query(
      "SELECT id, name, email, updated_at FROM customers " +
      "WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '" + STUCK_MINUTES + " minutes'"
    );
  } catch (err) {
    console.error('[reaper] could not query stuck customers:', err.message);
    return;
  }
  for (const c of result.rows) {
    if (_alertedStuck.has(c.id)) continue;
    _alertedStuck.add(c.id);
    console.warn('[reaper] customer stuck in processing: ' + c.id + ' (' + (c.name || '') + ')');
    try {
      await emailAdminStuck(c);
    } catch (e) {
      console.error('[reaper] could not email Ken about stuck customer:', e.message);
      _alertedStuck.delete(c.id); // allow a retry on the next tick
    }
  }
}

// ----------------------------------------------------------------------------
// Boot recovery. When the process restarts (deploy or crash), any voice-revision
// left in revision_status='working' is orphaned — the async job applying it is
// gone and will never finish, and the customer's "make a change" button stays
// blocked. On boot we reset those to 'error' with a friendly message (which
// unblocks the customer to try again) and, if any were found, tell Ken. This is
// the one stuck state the time-based reaper can't see (drafts have no
// updated_at), so we sweep it once at startup instead.
// ----------------------------------------------------------------------------
async function recoverStuckOnBoot() {
  if (!db.enabled) return;
  let rows = [];
  try {
    const result = await db.query(
      "UPDATE drafts SET revision_status = 'error', revision_error = $1 " +
      "WHERE revision_status = 'working' RETURNING id, customer_id",
      ['Your change didn’t finish because our server restarted. Please say your change again — nothing was lost.']
    );
    rows = result.rows || [];
  } catch (err) {
    console.error('[boot-recovery] could not sweep interrupted revisions: ' + err.message);
    return;
  }
  if (rows.length === 0) return;
  console.warn('[boot-recovery] reset ' + rows.length + ' interrupted revision(s): working -> error');
  try {
    const names = [];
    for (const r of rows) {
      const c = await db.queryOne('SELECT name, email FROM customers WHERE id = $1', [r.customer_id]);
      names.push(((c && c.name) || 'a customer') + (c && c.email ? ' (' + c.email + ')' : ''));
    }
    await emailAdminInterruptedRevisions(names);
  } catch (e) {
    console.error('[boot-recovery] could not email Ken about interrupted revisions: ' + e.message);
  }
}

// ----------------------------------------------------------------------------
// Boot recovery for the MAIN pipeline. A customer left in status='processing'
// when the process died (deploy/crash) is orphaned — the async pipeline that was
// preparing their memoir is gone, and every re-entry point (finish-recording,
// finish-follow-ups, reopen) blocks while 'processing', so they'd be frozen
// forever. On boot we re-run the pipeline for each: already-transcribed
// recordings are skipped (cheap), so it simply finishes the memoir. A
// genuinely-failing one is flipped to 'error' by the pipeline's own handling
// (so this can't loop across restarts), and Ken is told either way.
// ----------------------------------------------------------------------------
async function resumeStuckProcessingOnBoot() {
  if (!db.enabled) return;
  let rows = [];
  try {
    const result = await db.query("SELECT id, name, email FROM customers WHERE status = 'processing'");
    rows = result.rows || [];
  } catch (err) {
    console.error('[boot-recovery] could not query stuck-processing customers: ' + err.message);
    return;
  }
  if (rows.length === 0) return;
  console.warn('[boot-recovery] resuming ' + rows.length + ' memoir(s) stranded in processing by the restart');
  // Fire each async so boot isn't blocked; the pipeline manages its own status.
  for (const c of rows) {
    runCleanupPipeline(c.id).catch(function (e) {
      console.error('[boot-recovery] resume failed for ' + c.id + ': ' + (e && e.message));
    });
  }
  try {
    await emailAdminResumed(rows);
  } catch (e) {
    console.error('[boot-recovery] could not email Ken about resumed memoirs: ' + e.message);
  }
}

async function emailAdminResumed(rows) {
  const subject = 'Memory Box: auto-resumed ' + rows.length + ' memoir' + (rows.length === 1 ? '' : 's') + ' after a restart';
  const list = rows.map(function (r) {
    return '<li>' + escapeHtml((r.name || 'a customer') + (r.email ? ' (' + r.email + ')' : '')) + '</li>';
  }).join('');
  const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#8b5a2b;">A restart interrupted some memoirs — now re-running</h2>' +
'<p>The server restarted while ' + rows.length + ' memoir' + (rows.length === 1 ? ' was' : 's were') + ' being prepared, so ' + (rows.length === 1 ? 'it was' : 'they were') + ' automatically re-run (already-transcribed recordings are skipped):</p>' +
'<ul>' + list + '</ul>' +
'<p style="color:#7a726a;font-size:13px;">No action needed — they will finish on their own. If one genuinely can’t finish, you’ll get a separate “error” alert for it.</p>' +
'</div>';
  return sendEmail('kbakerbcs1@gmail.com', subject, html);
}

// ----------------------------------------------------------------------------
// Heartbeat / dead-man's-switch. Sends Ken a short "still alive + quick status"
// email on a daily timer (and on demand via the admin "Test alerts" button). Its
// real purpose: EVERY alert in this system rides on one email provider (Resend),
// so if that channel — or the whole service — ever breaks, all alerts go silent
// and Ken (who isn't watching dashboards) is blind. A regular heartbeat flips
// that around: as long as it keeps arriving, the pipe is healthy; if it STOPS
// arriving, the silence itself is the warning. Doubles as a daily nudge to clear
// any drafts waiting for review. reason='manual test' => a one-off confirmation.
// ----------------------------------------------------------------------------
async function sendHeartbeat(reason) {
  if (!db.enabled) return;
  let s = { total: 0, draftReady: 0, processing: 0, error: 0 };
  try {
    const r = await db.query(
      "SELECT " +
      "COUNT(*) FILTER (WHERE deleted_at IS NULL) AS total, " +
      "COUNT(*) FILTER (WHERE status = 'draft_ready' AND deleted_at IS NULL) AS draft_ready, " +
      "COUNT(*) FILTER (WHERE status = 'processing' AND deleted_at IS NULL) AS processing, " +
      "COUNT(*) FILTER (WHERE status = 'error' AND deleted_at IS NULL) AS error " +
      "FROM customers"
    );
    const row = (r.rows && r.rows[0]) || {};
    s = { total: +row.total || 0, draftReady: +row.draft_ready || 0, processing: +row.processing || 0, error: +row.error || 0 };
  } catch (e) {
    console.error('[heartbeat] could not gather stats: ' + e.message);
  }
  const isTest = (reason === 'manual test');
  const flagged = (s.error > 0 || s.processing > 0);
  const subject = isTest
    ? 'Memory Box: test alert — your notifications are working ✅'
    : 'Memory Box daily check — all healthy ✅';
  const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#8b5a2b;">BCS Memory Box — ' + (isTest ? 'test alert' : 'daily check') + '</h2>' +
(isTest
  ? '<p>You asked to test your alerts — and here it is. If this reached your inbox, your notification email is working. 👍</p>'
  : '<p>Everything is running. You get this so that if it ever <em>stops</em> arriving, you know something needs a look.</p>') +
'<ul>' +
'<li><strong>' + s.total + '</strong> customers</li>' +
'<li><strong>' + s.draftReady + '</strong> draft' + (s.draftReady === 1 ? '' : 's') + ' waiting for your review</li>' +
(s.processing ? '<li style="color:#c0392b;"><strong>' + s.processing + '</strong> currently processing</li>' : '') +
(s.error ? '<li style="color:#c0392b;"><strong>' + s.error + '</strong> in an error state — worth a look</li>' : '') +
'</ul>' +
(flagged ? '<p><a href="https://www.bcsmemorybox.com/admin.html" style="color:#8b5a2b;">Open the admin dashboard →</a></p>' : '') +
'</div>';
  return sendEmail('kbakerbcs1@gmail.com', subject, html);
}

// ----------------------------------------------------------------------------
// Follow-up questions: read the transcripts + the first draft, and propose a
// few gentle spoken-style questions that would draw out richer detail. Strictly
// about things they already mentioned; never new topics or genealogy.
// ----------------------------------------------------------------------------
const FOLLOWUP_SYSTEM_PROMPT = [
"You help enrich a senior's memoir. You are given everything the storyteller recorded and the draft memoir we wrote from it. Find the few places where a story is THIN - mentioned only in passing, or where one warm follow-up question would draw out a richer memory the family would treasure.",
"Write UP TO FOUR follow-up questions, addressed directly to the storyteller ('you'), in simple, warm, spoken language - the way a grandchild might ask across the kitchen table. Each question must invite a specific memory or detail they ALREADY touched on. Never introduce a brand-new topic they did not mention. Never ask for names, dates, or genealogy (those are handled elsewhere).",
"If the memoir is already rich and complete, it is perfectly fine to return FEWER questions, or NONE. Quality over quantity - only ask what would genuinely make the book better.",
"Return ONLY the questions, one per line. No numbering, no bullet points, no preamble, no closing remarks. If there are no good questions to ask, return nothing at all.",
].join("\n");

async function generateFollowUpQuestions(combinedTranscripts, draftMarkdown) {
  const userMsg =
    "Here is everything the storyteller recorded:\n\n" + combinedTranscripts +
    "\n\n----\n\nHere is the draft memoir we wrote from it:\n\n" + draftMarkdown;
  const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system: FOLLOWUP_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!resp.ok) throw new Error('Claude API error (follow-ups): ' + await resp.text());
  const data = await resp.json();
  const text = (data.content || []).map(function (b) { return b.text || ''; }).join('');
  return text
    .split('\n')
    .map(function (line) { return line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim(); })
    .filter(function (line) { return line.length > 0; })
    .slice(0, 4);
}

// ---------------------------------------------------------------------------
// PERSONALIZED "next question" for the recording page — suggests the ONE next
// thing to talk about, built from what the storyteller has already recorded.
// Used by the /api/customer/next-question progressive-enhancement endpoint.
// ---------------------------------------------------------------------------
const NEXT_QUESTION_SYSTEM_PROMPT = [
"You help a senior tell their life story by suggesting the SINGLE next thing to talk about. You will receive transcripts of the stories they have already recorded.",
"Return ONE short, warm, specific question that invites a NEW story they have not told yet, or gently draws out more about a person, place, or moment they only touched on. It should feel like a caring interviewer who actually listened and asks the natural next question.",
"RULES:",
"- ONE question only. No preamble, no lead-in, no lists, no quotation marks. Output only the question itself.",
"- Make it concrete and specific (a person, a place, an object, a day) so it is easy to answer. Never vague like 'tell me more about your life'.",
"- Do NOT ask about something they already covered well. Move them forward to new ground.",
"- Warm, plain, grandparent-friendly. One sentence, or two short ones at most.",
"- Only build on what the transcripts actually contain. Never invent facts about them.",
].join('\n');

async function generateNextQuestion(combinedTranscripts, name) {
  const userMsg = 'The storyteller' + (name ? ' (' + name + ')' : '') +
    ' has recorded these stories so far:\n\n' + combinedTranscripts +
    '\n\n----\n\nSuggest the ONE next question to ask them.';
  const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 200,
      system: NEXT_QUESTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!resp.ok) throw new Error('Claude API error (next-question): ' + await resp.text());
  const data = await resp.json();
  const text = (data.content || []).map(function (b) { return b.text || ''; }).join('').trim();
  // Strip any stray leading bullet/number/quote or trailing quote.
  return text.replace(/^["'\s]*(?:[-*•]|\d+[.)])?\s*/, '').replace(/\s*["']\s*$/, '').trim();
}

// Transcribe ONE recording in the background (fire-and-forget). NON-THROWING:
// on failure it just marks the row 'error' and the finish pipeline will
// re-transcribe anything not 'completed', so nothing is ever lost. This gets a
// transcript ready EARLY (while the storyteller is still recording) so the next
// visit can show a personalized next question.
async function transcribeRecordingInBackground(recording, isCouple) {
  if (!recording || !recording.storage_key) return;
  try {
    await db.query("UPDATE recordings SET transcript_status = 'transcribing' WHERE id = $1 AND transcript_status IS DISTINCT FROM 'completed'", [recording.id]);
    const transcript = await transcribeFromR2(recording.storage_key, isCouple ? { speakerLabels: true, speakersExpected: 2 } : {});
    await db.query("UPDATE recordings SET transcript = $1, transcript_status = 'completed' WHERE id = $2", [transcript, recording.id]);
  } catch (e) {
    console.error('[next-question] background transcribe failed for ' + recording.id + ': ' + e.message);
    try { await db.query("UPDATE recordings SET transcript_status = 'error', transcript_error = $1 WHERE id = $2", [String(e.message).slice(0, 300), recording.id]); } catch (e2) {}
  }
}

// Invite the customer to answer their follow-up questions (spoken), enriching
// their book. Links them back to their story page.
async function emailCustomerFollowUp(customer) {
  const portalUrl = 'https://www.bcsmemorybox.com/yourstory.html?token=' + encodeURIComponent(customer.access_token);
  const subject = 'A few quick questions to make your story even richer';
  const html =
    '<div style="font-family:Georgia,serif;color:#2a2520;max-width:560px;">' +
    '<p>Hi ' + (customer.name || 'there') + ',</p>' +
    '<p>Your first draft is written — and it is coming along beautifully. Before we finish it, we have <strong>a few short questions</strong> that would draw out a little more of your story and make the book even richer.</p>' +
    '<p>They take just a couple of minutes, and you answer them <strong>the same easy way — just talking</strong>, right on your story page:</p>' +
    '<p style="text-align:center;margin:24px 0;"><a href="' + portalUrl + '" style="background:#8b5a2b;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;">Answer a few questions</a></p>' +
    '<p style="color:#5a4a3a;font-size:14px;">Prefer to skip them? That is fine too — there is a button on that page to finish your book as it is.</p>' +
    '<p style="color:#5a4a3a;">— BCS Memory Box</p>' +
    '</div>';
  return sendEmail(customer.email, subject, html);
}

// ============================================================================
// VOICE REVISIONS — a customer speaks one change; the AI applies ONLY that
// change to the finished memoir and reports back, in plain words, what it did.
// ============================================================================
const REVISION_SYSTEM_PROMPT = [
"You are helping a senior make ONE change to their finished memoir. You will receive their full memoir (Markdown) and a spoken instruction describing what they want changed. Apply ONLY that change and return the whole memoir again.",
"",
"RULES:",
"- Make the SMALLEST edit that satisfies their instruction. Do not rewrite, restructure, re-title, re-order, or 'improve' anything they did not ask about. Every other word must stay EXACTLY as it was.",
"- Keep their voice and the existing style. Keep every [[PHOTO:N]] marker line exactly where it is, unless the instruction is specifically about a photo.",
"- STRICTLY THEIR OWN WORDS. You MAY: correct a fact/name/date they fix, add a short passage they dictate (using only what their instruction actually says), remove what they ask to remove, or reword a specific spot they point to. You MAY NOT invent memories, facts, feelings, places, or details they did not give. Never fabricate to fill a gap.",
"- If the instruction is unclear, or you cannot safely tell what to change, make NO change and explain that in the summary instead.",
"",
"Return your answer in EXACTLY this format and nothing else:",
"SUMMARY: <one short, warm, plain sentence telling them exactly what you changed — e.g. \"I changed your father's birth year from 1928 to 1932.\" If you made no change, say so and why, in one sentence. Never mention Markdown, files, or editing jargon.>",
"---MEMOIR---",
"<the full memoir in Markdown, with the change applied (or unchanged if you made no change)>"
].join("\n");

async function applyRevision(currentMarkdown, instruction, customerName) {
  const userMsg =
    "Storyteller: " + (customerName || '') + "\n\n" +
    "=== THEIR SPOKEN INSTRUCTION (what they want changed) ===\n" + instruction + "\n\n" +
    "=== THEIR CURRENT MEMOIR (Markdown) ===\n" + (currentMarkdown || '');

  const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 16000,
      stream: true,
      system: REVISION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!resp.ok) throw new Error('Claude revision error: ' + await resp.text());
  const text = (await readClaudeStream(resp)).trim();

  // Parse the delimiter format (robust against multi-line Markdown).
  const marker = text.indexOf('---MEMOIR---');
  let summary, memoir;
  if (marker !== -1) {
    const head = text.slice(0, marker);
    memoir = text.slice(marker + '---MEMOIR---'.length).trim();
    const sm = head.match(/SUMMARY:\s*([\s\S]*)/i);
    summary = sm ? sm[1].trim() : head.trim();
  } else {
    // Model didn't follow the format — treat the whole thing as the memoir.
    memoir = text;
    summary = 'Your change has been applied.';
  }
  if (!memoir) memoir = currentMarkdown || '';
  if (!summary) summary = 'Your change has been applied.';
  return { revisedMarkdown: memoir, changeSummary: summary };
}

// Load a customer's photos WITH image bytes (HEIC-converted + EXIF-oriented),
// ready to be re-placed into a regenerated .docx.
async function loadCustomerPhotos(customerId) {
  const { rows: photoRows } = await db.query(
    `SELECT id, storage_key, caption, content_type, original_filename
     FROM photos WHERE customer_id = $1 ORDER BY created_at ASC`,
    [customerId]
  );
  const photos = [];
  for (const ph of photoRows) {
    try {
      ph.buffer = await storage.getObjectBuffer(ph.storage_key);
      if (ph.buffer && isHeic(ph.buffer, ph.original_filename, ph.content_type)) {
        try {
          const heicConvert = require('heic-convert');
          ph.buffer = Buffer.from(await heicConvert({ buffer: ph.buffer, format: 'JPEG', quality: 0.9 }));
          ph.content_type = 'image/jpeg';
          ph.original_filename = (ph.original_filename || 'photo').replace(/\.(heic|heif)$/i, '') + '.jpg';
        } catch (e) { console.error('[revision] HEIC convert failed ' + ph.id + ': ' + e.message); }
      }
      if (ph.buffer) ph.buffer = await autoOrient(ph.buffer, ph.content_type, ph.original_filename);
    } catch (e) {
      ph.buffer = null;
      console.error('[revision] could not load photo ' + ph.id + ': ' + e.message);
    }
    photos.push(ph);
  }
  return photos;
}

// Runs ASYNCHRONOUSLY (not in the HTTP request). Transcribes the spoken
// instruction, applies it, regenerates the .docx, and stores the result plus a
// plain-language summary. Keeps the prior version so the customer can undo.
async function runRevisionAsync(customerId, draftId, instructionStorageKey) {
  try {
    const instruction = (await transcribeFromR2(instructionStorageKey)).trim();
    if (!instruction) throw new Error('We could not hear the change clearly. Please try saying it again.');

    const draft = await db.queryOne(
      'SELECT id, markdown_content, docx_storage_key FROM drafts WHERE id = $1 AND customer_id = $2',
      [draftId, customerId]
    );
    if (!draft) throw new Error('Draft not found.');
    const customer = await db.queryOne('SELECT name FROM customers WHERE id = $1', [customerId]);

    const { revisedMarkdown, changeSummary } =
      await applyRevision(draft.markdown_content || '', instruction, customer ? customer.name : '');

    const photos = await loadCustomerPhotos(customerId);
    const docxBuffer = await renderMemoirDocx(revisedMarkdown, photos);
    const newDocxKey = 'customers/' + customerId + '/drafts/rev-' + Date.now() + '.docx';
    await storage.uploadObject(
      newDocxKey, docxBuffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    // Regenerate the print-ready interior + cover PDFs to match the revision.
    let newInteriorKey = null, newPageCount = null, newCoverKey = null;
    try {
      const pdf = await renderAndUploadInteriorPdf(customerId, revisedMarkdown, photos, 'rev');
      newInteriorKey = pdf.key; newPageCount = pdf.pageCount;
    } catch (e) {
      console.error('[revision] interior PDF failed (non-fatal): ' + e.message);
    }
    try {
      const cov = await renderAndUploadCoverPdf(customerId, customer ? customer.name : '', newPageCount || 24, 'cover-rev');
      newCoverKey = cov.key;
    } catch (e) {
      console.error('[revision] cover PDF failed (non-fatal): ' + e.message);
    }

    await db.query(
      `UPDATE drafts SET
         prev_markdown_content = markdown_content,
         prev_docx_storage_key = docx_storage_key,
         prev_interior_pdf_key = interior_pdf_key,
         prev_cover_pdf_key = cover_pdf_key,
         prev_page_count = page_count,
         markdown_content = $1,
         docx_storage_key = $2,
         last_change_summary = $3,
         revision_status = 'applied',
         revision_error = NULL,
         interior_pdf_key = COALESCE($5, interior_pdf_key),
         cover_pdf_key = COALESCE($6, cover_pdf_key),
         page_count = COALESCE($7, page_count)
       WHERE id = $4`,
      [revisedMarkdown, newDocxKey, changeSummary, draftId, newInteriorKey, newCoverKey, newPageCount]
    );

    try { await storage.deleteObject(instructionStorageKey); } catch (e) { /* best effort */ }
    console.log('[revision] applied for customer ' + customerId + ' — ' + changeSummary);
  } catch (err) {
    console.error('[revision] FAILED for customer ' + customerId + ': ' + err.message);
    await db.query(
      "UPDATE drafts SET revision_status = 'error', revision_error = $1 WHERE id = $2",
      [err.message, draftId]
    ).catch(() => {});
  }
}

module.exports = {
  runCleanupPipeline,
  generateFollowUpQuestions,
  generateNextQuestion,
  transcribeRecordingInBackground,
  transcribeFromR2,
  emailAdminDraftReady,
  checkStuckCustomers,
  recoverStuckOnBoot,
  resumeStuckProcessingOnBoot,
  sendHeartbeat,
  MEMOIR_SYSTEM_PROMPT,
  renderMemoirDocx, // exported so we can unit-test the renderer
  polishWithClaude, // exported so we can iterate on the prompt with sample data
  qualityPassWithClaude, // exported so we can iterate/test the proofread pass
  applyRevision,    // voice-revision: apply one spoken change
  runRevisionAsync, // voice-revision: async orchestrator
  loadCustomerPhotos,
};

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
"3. STRICTLY THEIR OWN WORDS - smoothed, never invented. This is the firm line and it is absolute. You MAY: reorder and group what they said, connect fragments into flowing paragraphs, trim filler/repetition/false starts, fix grammar, and correct obvious transcription errors (especially garbled proper names). You MAY NOT: invent a memory, scene, place, event, feeling, or line of dialogue; add sensory details they never mentioned; assign feelings they did not express; or fill a gap with a plausible-sounding fact or date. Every sentence must be something they ACTUALLY TOLD US - just told better. If you cannot point to where a sentence came from in their recordings, do not write it. Preserve their uncertainty ('I think it was around 1962' stays 'around 1962'); never fabricate certainty.",
"",
"HOW TO WRITE IT:",
"- OPEN ON A VIVID, REAL MEMORY - never on birth dates or genealogy. Find the most evocative TRUE thing they said and lead the whole book with it. (You are selecting and sequencing a real memory for impact, not inventing one.)",
"- Within each chapter, put things in a natural order (usually chronological) and connect the fragments into flowing paragraphs, using only the lightest connective transitions ('The next thing I remember is...', 'Then there was...').",
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
// Top-level orchestrator. Throws on any error; caller decides how to handle.
// ----------------------------------------------------------------------------
async function runCleanupPipeline(customerId) {
  const customer = await db.queryOne(
    'SELECT id, email, name, access_token, follow_up_done FROM customers WHERE id = $1',
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
        const transcript = await transcribeFromR2(r.storage_key);
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

    const memoirMarkdown = await polishWithClaude(customer.name, combined, photos, answeredQA);

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

    // 6. Save draft row
    const draft = await db.queryOne(
      `INSERT INTO drafts (customer_id, version, markdown_content, docx_storage_key, status)
       VALUES ($1, 1, $2, $3, 'ready_for_review')
       ON CONFLICT (customer_id, version) DO UPDATE
       SET markdown_content = EXCLUDED.markdown_content,
           docx_storage_key = EXCLUDED.docx_storage_key,
           status = EXCLUDED.status,
           created_at = NOW()
       RETURNING id`,
      [customerId, memoirMarkdown, docxKey]
    );

    // 7. FIRST DRAFT ONLY: ask the storyteller a few gentle follow-up questions
    //    to enrich thin stories, then pause for their spoken answers. On the
    //    re-run (answers present) or if they skipped, we finalize instead.
    if (!customer.follow_up_done && answeredQA.length === 0) {
      let questions = [];
      try { questions = await generateFollowUpQuestions(combined, memoirMarkdown); }
      catch (e) { console.error('[cleanup] follow-up question generation failed: ' + e.message); }
      if (questions.length > 0) {
        for (let i = 0; i < questions.length; i++) {
          await db.query('INSERT INTO follow_up_questions (customer_id, question, sort_order) VALUES ($1, $2, $3)', [customerId, questions[i], i]);
        }
        await db.query("UPDATE customers SET status = 'follow_up' WHERE id = $1", [customerId]);
        try { await emailCustomerFollowUp(customer); }
        catch (e) { console.error('[cleanup] could not email customer follow-up: ' + e.message); }
        console.log('[cleanup] First draft done; generated ' + questions.length + ' follow-up question(s), awaiting answers.');
        return draft.id; // stop here — draft saved but not delivered until they answer or skip
      }
      // no questions worth asking -> fall through and finalize
    }

    // 8. FINALIZE: draft is ready for Ken.
    await db.query("UPDATE customers SET status = 'draft_ready', follow_up_done = TRUE WHERE id = $1", [customerId]);
    await emailAdminDraftReady(customer, draft.id);

    console.log('[cleanup] Pipeline complete for ' + customer.name + ' — draft ' + draft.id);
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
async function transcribeFromR2(storageKey) {
  const audioBuffer = await storage.getObjectBuffer(storageKey);

  // 1. Upload bytes to AssemblyAI
  const upResp = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { 'Authorization': process.env.ASSEMBLYAI_API_KEY },
    body: audioBuffer,
  });
  if (!upResp.ok) throw new Error('AAI upload failed: ' + await upResp.text());
  const { upload_url } = await upResp.json();

  // 2. Submit for transcription
  const subResp = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      'Authorization': process.env.ASSEMBLYAI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: upload_url,
      language_code: 'en',
      speech_models: ['universal-2'],
    }),
  });
  if (!subResp.ok) throw new Error('AAI submit failed: ' + await subResp.text());
  const { id: tid } = await subResp.json();

  // 3. Poll until done (longer recordings take longer — up to ~5 minutes for an hour of audio)
  // We poll for up to 10 minutes.
  for (let i = 0; i < 150; i++) {
    await sleep(4000);
    const stResp = await fetch('https://api.assemblyai.com/v2/transcript/' + tid, {
      headers: { 'Authorization': process.env.ASSEMBLYAI_API_KEY },
    });
    const data = await stResp.json();
    if (data.status === 'completed') return data.text || '';
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

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 16000,
      system: MEMOIR_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!resp.ok) throw new Error('Claude API error: ' + await resp.text());
  const data = await resp.json();
  const text = (data.content || []).map(b => b.text || '').join('');
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

async function sendEmail(to, subject, html) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'BCS Memory Box <ops@bcsmemorybox.com>',
      to: to,
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
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
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

module.exports = {
  runCleanupPipeline,
  generateFollowUpQuestions,
  emailAdminDraftReady,
  checkStuckCustomers,
  MEMOIR_SYSTEM_PROMPT,
  renderMemoirDocx, // exported so we can unit-test the renderer
  polishWithClaude, // exported so we can iterate on the prompt with sample data
};

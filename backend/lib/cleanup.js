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
"You are helping turn a senior's recorded life story into a beautiful memoir document. The senior recorded a series of audio clips about their life, and each clip has been transcribed below. Each transcript is labeled with [RECORDING N — filename].",
"",
"Your task: organize ALL the transcripts into a single coherent memoir, written in the storyteller's own voice but polished so it reads like a published memoir.",
"",
"ORGANIZE THE CONTENT INTO EXACTLY FOUR SECTIONS:",
"1. Family and Origins — parents, grandparents, ancestors, where the family came from",
"2. Early Childhood — growing up, friends, school, the world they knew as a child",
"3. Family Life — marriage, children, raising a family, vacations, traditions",
"4. Reflections — likes and dislikes, what mattered to them, who they are, how they see the world",
"",
"For each piece of content, decide which section it best belongs in. If a recording spans multiple sections, place it where it's most central. If multiple recordings cover the same topic, combine them thoughtfully into a single coherent narrative — don't repeat the same anecdote twice. Within each section, organize chronologically or thematically, whichever feels right.",
"",
"WRITING STYLE:",
"- Preserve the storyteller's authentic voice, vocabulary, and rhythm.",
"- Remove filler words (\"uh\", \"um\"), false starts, restarts, and stumbles.",
"- Fix grammar mistakes that would distract a reader, but don't over-polish — they should still sound like themselves.",
"- Preserve uncertainty when it's present (\"I think it was around 1962\" stays as \"around 1962\"). Never fabricate certainty.",
"- Add NO facts, names, dates, or details that weren't in the recordings. If a detail is unclear, leave the original phrasing.",
"- Use paragraph breaks between distinct ideas. Don't merge unrelated thoughts.",
"- Keep it conversational and warm, not flowery or formal.",
"- Don't add your own commentary, framing, or summary statements — just the storyteller's voice.",
"",
"OUTPUT FORMAT:",
"Return ONLY the memoir document as clean Markdown. Use exactly this structure:",
"",
"# [Storyteller's first name] — A Life in Four Parts",
"",
"## Family and Origins",
"[polished prose covering this section]",
"",
"## Early Childhood",
"[polished prose]",
"",
"## Family Life",
"[polished prose]",
"",
"## Reflections",
"[polished prose]",
"",
"If a section has no content because the storyteller didn't talk about that topic, write a single short italic note like:",
"*The storyteller did not record about this period of their life.*",
"",
"PHOTOGRAPHS (when a photo list is provided in the user\u2019s message):",
"The user may give you a numbered list of the storyteller\u2019s photographs, each with a caption. Place them INTO the story: wherever a passage clearly matches a photo\u2019s caption (the same people, event, place, or time), insert a line containing ONLY the marker [[PHOTO:N]] on its own line, between paragraphs, right after that passage. These marker lines ARE a required and allowed part of the output structure \u2014 include them even though the rest is prose.",
"Photo rules: use each photo number at most once; use only numbers that appear in the list; match by caption (names, dates, relationships); place as many as fit naturally throughout all four sections; if a photo has no clear home in the text, simply leave it out (leftover photos are collected into a Photographs section automatically). Never describe or mention the photo in the prose \u2014 output only the bare [[PHOTO:N]] marker line.",
"",
"Begin the memoir IMMEDIATELY. No preamble. No explanation of your process. No notes at the end. Just the memoir.",
].join("\n");

// ----------------------------------------------------------------------------
// Top-level orchestrator. Throws on any error; caller decides how to handle.
// ----------------------------------------------------------------------------
async function runCleanupPipeline(customerId) {
  const customer = await db.queryOne(
    'SELECT id, email, name, access_token FROM customers WHERE id = $1',
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
    const combined = recordings.map((r, i) =>
      '[RECORDING ' + (i + 1) + ' — ' + (r.original_filename || 'untitled') + ']\n' +
      (r.transcript || '(no transcript)')
    ).join('\n\n');
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
      } catch (e) {
        ph.buffer = null;
        console.error('[cleanup] could not load photo ' + ph.id + ': ' + e.message);
      }
      photos.push(ph);
    }
    console.log('[cleanup] Loaded ' + photos.length + ' photo(s) for placement');

    const memoirMarkdown = await polishWithClaude(customer.name, combined, photos);

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

    // 7. Flip customer status
    await db.query("UPDATE customers SET status = 'draft_ready' WHERE id = $1", [customerId]);

    // 8. Notify Ken
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
async function polishWithClaude(customerName, combinedTranscripts, photos) {
  photos = photos || [];
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
  const userMsg =
    "Storyteller's name: " + customerName + "\n\n" +
    "Here are the transcripts of their recordings. Organize and polish them into the memoir per the rules above:\n\n" +
    combinedTranscripts + photoBlock;

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

module.exports = {
  runCleanupPipeline,
  MEMOIR_SYSTEM_PROMPT,
  renderMemoirDocx, // exported so we can unit-test the renderer
  polishWithClaude, // exported so we can iterate on the prompt with sample data
};

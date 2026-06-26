// BCS Memory Box — backend service.
// Originally: free-trial endpoint only.
// V2 (May 2026): customer portal — signup, recording uploads, automated
// memoir cleanup, customer/admin dashboards.
// V3 (May 26 2026): Stripe checkout + webhook live. Dev mark-paid removed.

const express = require('express');
const multer = require('multer');
const path = require('path');

const db = require('./lib/db');
const customerRoutes = require('./routes/customer');
const uploadRoutes   = require('./routes/upload');
const photoRoutes    = require('./routes/photo');
const adminRoutes    = require('./routes/admin');
const finishRoutes   = require('./routes/finish');
const { checkoutRouter, webhookRouter } = require('./routes/stripe');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB cap for the 90-second trial (blocks oversized/abusive uploads)
});

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = new Set([
  'https://www.bcsmemorybox.com',
  'https://bcsmemorybox.com',
]);

// ============================================================================
// CORS — allow both www and bare domain. GitHub Pages redirects www → bare,
// so browser requests come from the bare origin.
// ============================================================================
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-session, stripe-signature');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ============================================================================
// Stripe webhook — MUST be mounted before any global JSON body parser,
// because Stripe signature verification requires the raw request body.
// The webhookRouter applies express.raw() internally for its single route.
// ============================================================================
app.use('/api/stripe/webhook', webhookRouter);

// ============================================================================
// Health checks
// ============================================================================
app.get('/', (req, res) => res.json({
  status: 'ok',
  service: 'bcs-memory-box-portal',
  version: '0.5.0',
  db: db.enabled,
  stripe: !!process.env.STRIPE_SECRET_KEY,
}));
app.get('/health', (req, res) => res.json({ status: 'ok', db: db.enabled }));

// ============================================================================
// Customer portal API
// ============================================================================
app.use('/api/customer', customerRoutes);
app.use('/api/customer', checkoutRouter);          // POST /api/customer/create-checkout-session
app.use('/api/customer/upload', uploadRoutes);
app.use('/api/customer/upload-photo', photoRoutes);

// Admin (Ken's dashboard)
app.use('/api/admin', adminRoutes);
app.use('/api/customer/finish-recording', finishRoutes);

// ============================================================================
// /trial — original free-trial endpoint (unchanged, still serves the homepage
// recording widget for visitors who want to hear a 90-second sample).
// ============================================================================
app.post('/trial', upload.single('audio'), async (req, res) => {
  try {
    const audio = req.file;
    const email = (req.body.email || '').trim();
    const name = (req.body.name || '').trim() || 'there';

    if (!audio) return res.status(400).json({ error: 'Missing audio file' });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Missing or invalid email' });
    }

    // 1. Upload audio to AssemblyAI
    const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { 'Authorization': process.env.ASSEMBLYAI_API_KEY },
      body: audio.buffer,
    });
    if (!uploadResp.ok) throw new Error('Audio upload failed: ' + await uploadResp.text());
    const { upload_url } = await uploadResp.json();

    // 2. Request transcription
    const submitResp = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        'Authorization': process.env.ASSEMBLYAI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ audio_url: upload_url, language_code: 'en', speech_models: ['universal-2'] }),
    });
    if (!submitResp.ok) throw new Error('Transcription submit failed: ' + await submitResp.text());
    const { id: transcriptId } = await submitResp.json();

    // 3. Poll for completion (90s audio usually done in 10-20s)
    let transcriptText = null;
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const statusResp = await fetch('https://api.assemblyai.com/v2/transcript/' + transcriptId, {
        headers: { 'Authorization': process.env.ASSEMBLYAI_API_KEY },
      });
      const data = await statusResp.json();
      if (data.status === 'completed') { transcriptText = data.text; break; }
      if (data.status === 'error') throw new Error('Transcription error: ' + data.error);
    }
    if (!transcriptText) throw new Error('Transcription timed out');

    // 4. Clean up via Claude
    const cleanedText = await cleanupWithClaude(transcriptText);

    // 5. Email via Resend
    await sendSampleEmail(email, name, cleanedText);

    res.json({
      success: true,
      message: 'Your sample is on its way — check your inbox in a minute or two.',
    });
  } catch (err) {
    console.error('Trial error:', err);
    res.status(500).json({
      error: 'Something went wrong on our end. Try again, or email Ken directly.',
    });
  }
});

async function cleanupWithClaude(transcript) {
  const systemPrompt =
"You are helping clean up a senior's voice recording into polished memoir prose. The senior recorded a short audio clip about a memory from their life.\n\n" +
"Clean it up into beautiful, warm, readable prose that:\n" +
"- Removes filler words (\"uh\", \"um\"), false starts, and stumbles.\n" +
"- Fixes obvious grammar mistakes.\n" +
"- Preserves the storyteller's authentic voice and word choices.\n" +
"- Maintains uncertainty when it's present (\"I think it was around 1960\" stays as \"around 1960\" — never fabricate certainty).\n" +
"- Stays conversational and natural — NOT overly polished, formal, or flowery.\n" +
"- Uses paragraph breaks between distinct ideas; never merges unrelated thoughts.\n" +
"- Adds no facts or details that weren't in the recording.\n\n" +
"Return ONLY the cleaned-up text. No preamble. No explanation. No headings.";

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Here is the transcribed recording:\n\n' + transcript }],
    }),
  });
  if (!resp.ok) throw new Error('Claude API error: ' + await resp.text());
  const data = await resp.json();
  return data.content[0].text.trim();
}

async function sendSampleEmail(toEmail, name, cleanedText) {
  const paragraphs = cleanedText
    .split(/\n{2,}/)
    .map(p => '<p>' + escapeHtml(p.trim()) + '</p>')
    .join('\n');

  const html = '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#faf8f4;">' +
'<div style="font-family:Georgia,serif;max-width:600px;margin:24px auto;line-height:1.65;color:#2a2520;background:#fff;padding:32px;border-radius:8px;">' +
'<p>Hi ' + escapeHtml(name) + ',</p>' +
'<p>Thanks for trying Memory Box. Here is the polished version of what you just recorded:</p>' +
'<div style="background:#faf7f0;border-left:4px solid #8b5a2b;padding:20px 28px;margin:28px 0;font-style:italic;">' +
paragraphs +
'</div>' +
'<p>That is what a 90-second clip becomes. Imagine your whole story — family, childhood, the moments that shaped you — preserved this way.</p>' +
'<p>If you would like to go further, the full Memory Box service is <strong>$125</strong>. We capture your life story in four sections, deliver a polished memoir document, and there are optional add-ons for photographs and a printed hardcover book.</p>' +
'<p style="margin-top:32px;">' +
'<a href="https://www.bcsmemorybox.com" style="background:#8b5a2b;color:#fff;padding:14px 28px;text-decoration:none;border-radius:4px;display:inline-block;font-family:Georgia,serif;">See the full service</a>' +
'</p>' +
'<p style="margin-top:32px;">Reply to this email if you have any questions.</p>' +
'<p>— Ken Baker<br>BCS Memory Box<br><a href="https://www.bcsmemorybox.com" style="color:#8b5a2b;">www.bcsmemorybox.com</a></p>' +
'</div></body></html>';

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'BCS Memory Box <sample@bcsmemorybox.com>',
      to: toEmail,
      reply_to: 'kbakerbcs1@gmail.com',
      subject: 'Here is your Memory Box sample',
      html,
    }),
  });
  if (!resp.ok) throw new Error('Resend error: ' + await resp.text());
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================================
// Startup: run any pending database migrations, then start listening.
// ============================================================================
(async () => {
  try {
    await db.runMigrations();
  } catch (err) {
    console.error('[startup] migration error:', err.message);
    console.error('[startup] starting server anyway — trial endpoint will still work without DB');
  }
  app.listen(PORT, () => {
    console.log('BCS Memory Box portal server listening on port ' + PORT);
    console.log('  db: ' + (db.enabled ? 'connected' : 'NOT CONFIGURED (DATABASE_URL missing)'));
    console.log('  stripe: ' + (process.env.STRIPE_SECRET_KEY ? 'configured' : 'NOT CONFIGURED'));
  });
})();

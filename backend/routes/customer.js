// Customer-facing endpoints: signup, lookup own data via access_token.
// No password — the access_token in the URL IS the credential.

const express = require('express');
const multer = require('multer');
const db = require('../lib/db');
const mailer = require('../lib/mailer');
const { runCleanupPipeline, emailAdminDraftReady, runRevisionAsync, transcribeRecordingInBackground, generateNextQuestion } = require('../lib/cleanup');
// In-memory cache of the personalized "next question" per customer, keyed on how
// many of their recordings are transcribed — so we only call the AI when that
// grows, not on every page load. Lost on restart (just regenerates); no DB needed.
const _nextQCache = new Map();
const printOrder = require('../lib/printOrder');
const lulu = require('../lib/lulu');
const pricing = require('../lib/pricing');

const router = express.Router();
router.use(express.json());

// In-memory upload for a spoken revision instruction (short clips; cap 25 MB).
const reviseUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ----------------------------------------------------------------------------
// POST /api/customer/signup
// Creates a new customer in 'awaiting_payment' status. Returns an access_token.
// The frontend then redirects the customer to Stripe checkout with this token
// as the client_reference_id, and after payment lands them at /yourstory/<token>.
// ----------------------------------------------------------------------------
router.post('/signup', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();

    if (!name || name.length < 1) {
      return res.status(400).json({ error: 'Please enter your name.' });
    }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    // The only product we sell is the $299 Hardcover Memoir. Any unset/unknown
    // plan defaults to hardcover — never one of the retired lower/higher tiers.
    // (See lib/pricing.js for the single source of truth.)
    let plan = (req.body.plan || pricing.DEFAULT_PLAN).toString().toLowerCase();
    if (!pricing.ALLOWED_PLANS.includes(plan)) plan = pricing.DEFAULT_PLAN;

    // If a customer already exists for this email and hasn't paid yet, reuse the
    // existing access_token (so they can retry checkout instead of getting blocked).
    // If they've already paid, send them back to their existing portal URL.
    const existing = await db.queryOne(
      'SELECT id, name, access_token, status, paid_at FROM customers WHERE email = $1',
      [email]
    );

    if (existing) {
      // SECURITY: never return an existing account's access token to an
      // unauthenticated caller keyed only on email — that token IS the login, so
      // returning it here would let anyone who knows a customer's email take over
      // their account. Instead, email the link to the address on file (the same
      // safe pattern as /request-link) and tell them to check their inbox.
      // Brand-new sign-ups (below) still go straight to checkout.
      if (!existing.paid_at) {
        // Has an account but hasn't paid: keep their chosen plan current so the
        // emailed link resumes checkout at the right price.
        await db.query('UPDATE customers SET plan = $1 WHERE id = $2', [plan, existing.id]).catch(function(){});
      }
      try {
        await mailer.sendStoryLink(email, existing.name, existing.access_token, false);
        console.log('[customer/signup] existing account — link re-sent to ' + email);
      } catch (mailErr) {
        console.error('[customer/signup] resend link failed: ' + mailErr.message);
      }
      return res.json({
        ok: true,
        alreadyExists: true,
        emailed: true,
        message: "You already have an account — we've just emailed your link to " + email + ". Please check your inbox (and your spam folder).",
      });
    }

    const accessToken = db.randomToken(24);
    const result = await db.queryOne(
      `INSERT INTO customers (email, name, access_token, status, plan)
       VALUES ($1, $2, $3, 'awaiting_payment', $4)
       RETURNING id, access_token`,
      [email, name, accessToken, plan]
    );

    res.json({
      ok: true,
      alreadyExists: false,
      accessToken: result.access_token,
      message: 'Account created. Heading to checkout.',
    });
  } catch (err) {
    console.error('[customer/signup] error:', err);
    res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
  }
});

// ----------------------------------------------------------------------------
// GET /api/customer/me?token=<access_token>
// Returns the customer's own data (status, recordings, photos, drafts).
// Used by the customer's personal portal page.
// ----------------------------------------------------------------------------
router.get('/me', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const customer = await db.queryOne(
      `SELECT id, email, name, status, paid_at, created_at, plan, approved_at,
              is_couple, partner_name,
              ship_name, ship_address1, ship_address2, ship_city, ship_state, ship_zip, ship_country, ship_phone
       FROM customers
       WHERE access_token = $1`,
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    const { rows: recordings } = await db.query(
      `SELECT id, original_filename, size_bytes, duration_seconds,
              transcript_status, created_at, title
       FROM recordings
       WHERE customer_id = $1
       ORDER BY created_at ASC`,
      [customer.id]
    );

    const { rows: photos } = await db.query(
      `SELECT id, original_filename, size_bytes, content_type, caption, created_at
       FROM photos
       WHERE customer_id = $1
       ORDER BY created_at ASC`,
      [customer.id]
    );

    const { rows: drafts } = await db.query(
      `SELECT id, version, status, approved_at, delivered_at, created_at
       FROM drafts
       WHERE customer_id = $1
       ORDER BY version DESC`,
      [customer.id]
    );

    const { rows: followUps } = await db.query(
      `SELECT id, question, sort_order, (answer_recording_id IS NOT NULL) AS answered
       FROM follow_up_questions WHERE customer_id = $1 ORDER BY sort_order ASC`,
      [customer.id]
    );

    // The memoir text the customer is allowed to read inline on their page.
    // Same visibility rule as the /download endpoint, so what they read here is
    // exactly what the .docx contains. Null until a reviewable draft exists.
    const memoirDraft = await db.queryOne(
      `SELECT version, markdown_content, revision_status, last_change_summary,
              revision_error, (prev_markdown_content IS NOT NULL) AS can_undo
       FROM drafts
       WHERE customer_id = $1
         AND status IN ('delivered', 'approved', 'ready_for_review')
       ORDER BY version DESC, created_at DESC
       LIMIT 1`,
      [customer.id]
    );

    res.json({
      ok: true,
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        status: customer.status,
        paidAt: customer.paid_at,
        createdAt: customer.created_at,
        isCouple: !!customer.is_couple,
        partnerName: customer.partner_name || null,
        plan: customer.plan || pricing.DEFAULT_PLAN,
        // Does this plan include a shipped hardcover? (drives the address form)
        includesHardcover: pricing.HARDCOVER_PLANS.has(customer.plan),
        approvedAt: customer.approved_at || null,
        // Is the "changed your mind?" undo still open? (approved within ~24h —
        // the window in which the Lulu order can still be stopped).
        canUndoApproval: customer.status === 'approved' && !!customer.approved_at &&
          (Date.now() - new Date(customer.approved_at).getTime()) < 24 * 60 * 60 * 1000,
        shipping: {
          name: customer.ship_name || '',
          address1: customer.ship_address1 || '',
          address2: customer.ship_address2 || '',
          city: customer.ship_city || '',
          state: customer.ship_state || '',
          zip: customer.ship_zip || '',
          country: customer.ship_country || '',
          phone: customer.ship_phone || '',
        },
      },
      recordings,
      photos,
      drafts,
      followUps,
      memoir: memoirDraft
        ? {
            version: memoirDraft.version,
            markdown: memoirDraft.markdown_content,
            revisionStatus: memoirDraft.revision_status || 'idle',
            changeSummary: memoirDraft.last_change_summary || null,
            revisionError: memoirDraft.revision_error || null,
            canUndo: !!memoirDraft.can_undo,
          }
        : null,
    });
  } catch (err) {
    console.error('[customer/me] error:', err);
    res.status(500).json({ error: 'Could not load your account data.' });
  }
});


// ---------------------------------------------------------------------------
// GET /api/customer/next-question?token=<access_token>
// A personalized "picking up where you left off" question for the recording
// page, built from what the storyteller has already recorded. Progressive
// enhancement: returns { question: null } until transcripts exist (the frontend
// keeps its curated question then). Fires background transcription for any
// not-yet-transcribed clips so the NEXT visit can be personalized. The generated
// question is cached per customer+transcribed-count to limit AI calls.
// ---------------------------------------------------------------------------
router.get('/next-question', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.json({ question: null });
    const customer = await db.queryOne(
      'SELECT id, name, is_couple FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.json({ question: null });

    const { rows: recs } = await db.query(
      'SELECT id, storage_key, transcript, transcript_status FROM recordings WHERE customer_id = $1 ORDER BY created_at ASC',
      [customer.id]
    );
    if (recs.length === 0) return res.json({ question: null });

    const done = recs.filter(function (r) { return r.transcript && r.transcript_status === 'completed'; });

    // Fire background transcription for clips not yet done (skip ones already
    // in-flight, done, or errored — so we never loop cost on a bad clip).
    recs.filter(function (r) {
      return !(r.transcript && r.transcript_status === 'completed') &&
             r.transcript_status !== 'transcribing' && r.transcript_status !== 'error';
    }).forEach(function (r) { transcribeRecordingInBackground(r, customer.is_couple); });

    if (done.length === 0) return res.json({ question: null });

    const cached = _nextQCache.get(customer.id);
    if (cached && cached.count === done.length) {
      return res.json({ question: cached.question, personalized: true });
    }

    const combined = done.map(function (r) { return (r.transcript || '').trim(); })
                         .filter(Boolean).join('\n\n----\n\n');
    let question = null;
    try { question = await generateNextQuestion(combined, customer.name); }
    catch (e) { console.error('[next-question] generation failed: ' + e.message); }
    if (!question) return res.json({ question: null });

    _nextQCache.set(customer.id, { count: done.length, question: question });
    res.json({ question: question, personalized: true });
  } catch (err) {
    console.error('[next-question] error:', err);
    res.json({ question: null });
  }
});


// ---------------------------------------------------------------------------
// GET /api/customer/download?token=<access_token>
// Streams the latest approved (or ready_for_review) .docx for this customer.
// ---------------------------------------------------------------------------
const storage = require('../lib/storage');

router.get('/download', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const customer = await db.queryOne(
      'SELECT id, name FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    const draft = await db.queryOne(
      `SELECT id, version, docx_storage_key, status
       FROM drafts
       WHERE customer_id = $1 AND docx_storage_key IS NOT NULL
         AND status IN ('delivered', 'approved', 'ready_for_review')
       ORDER BY version DESC, created_at DESC
       LIMIT 1`,
      [customer.id]
    );
    if (!draft) return res.status(404).json({ error: 'No memoir document available yet.' });

    const { stream, contentType, contentLength } =
      await storage.getObjectStream(draft.docx_storage_key);
    const safeName = (customer.name || 'memoir').replace(/[^A-Za-z0-9 _-]/g, '_');
    res.setHeader('Content-Type',
      contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Disposition',
      'attachment; filename="' + safeName + ' - Memory Box.docx"');
    stream.pipe(res);
  } catch (err) {
    console.error('[customer/download] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken if it keeps happening.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/customer/photo/:id?token=<access_token>
// Streams a single photo inline so it can be shown in an <img> tag on the
// customer's own story page. Scoped to the photo's owner via the access token.
// ---------------------------------------------------------------------------
router.get('/photo/:id', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const photo = await db.queryOne(
      `SELECT p.storage_key, p.content_type
       FROM photos p
       JOIN customers c ON c.id = p.customer_id
       WHERE p.id = $1 AND c.access_token = $2`,
      [req.params.id, token]
    );
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    const { stream, contentType, contentLength } = await storage.getObjectStream(photo.storage_key);
    res.setHeader('Content-Type', photo.content_type || contentType || 'image/jpeg');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    stream.pipe(res);
  } catch (err) {
    console.error('[customer/photo] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken if it keeps happening.' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/customer/photo/:id?token=<access_token>
// Lets the customer remove a photo they added by mistake.
// ---------------------------------------------------------------------------
router.delete('/photo/:id', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const photo = await db.queryOne(
      `SELECT p.id, p.storage_key
       FROM photos p
       JOIN customers c ON c.id = p.customer_id
       WHERE p.id = $1 AND c.access_token = $2`,
      [req.params.id, token]
    );
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    await db.query('DELETE FROM photos WHERE id = $1', [photo.id]);
    storage.deleteObject(photo.storage_key)
      .catch(e => console.warn('[customer/photo delete] storage cleanup failed:', e.message));

    res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('[customer/photo delete] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken if it keeps happening.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/customer/recording/:id/title?token=<access_token>
// Body: { title } — lets the customer label/rename one of their recordings.
// ---------------------------------------------------------------------------
router.put('/recording/:id/title', async (req, res) => {
  try {
    const token = req.query.token || (req.body && req.body.token);
    if (!token) return res.status(401).json({ error: 'Missing access token' });
    let title = (req.body && typeof req.body.title === 'string') ? req.body.title.trim() : '';
    if (title.length > 80) title = title.slice(0, 80);
    const rec = await db.queryOne(
      `SELECT r.id FROM recordings r
       JOIN customers c ON c.id = r.customer_id
       WHERE r.id = $1 AND c.access_token = $2`,
      [req.params.id, token]
    );
    if (!rec) return res.status(404).json({ error: 'Recording not found' });
    await db.query('UPDATE recordings SET title = $1 WHERE id = $2', [title || null, rec.id]);
    res.json({ ok: true, title: title || null });
  } catch (err) {
    console.error('[customer/recording title] error:', err);
    res.status(500).json({ error: 'Could not update the title. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/customer/photo/:id/caption?token=<access_token>
// Body: { caption } — lets the customer name/caption a photo after uploading
// (name + date, e.g. "Mom & Dad, Christmas 1975").
// ---------------------------------------------------------------------------
router.put('/photo/:id/caption', async (req, res) => {
  try {
    const token = req.query.token || (req.body && req.body.token);
    if (!token) return res.status(401).json({ error: 'Missing access token' });
    let caption = (req.body && typeof req.body.caption === 'string') ? req.body.caption.trim() : '';
    if (caption.length > 500) caption = caption.slice(0, 500);
    const photo = await db.queryOne(
      `SELECT p.id FROM photos p
       JOIN customers c ON c.id = p.customer_id
       WHERE p.id = $1 AND c.access_token = $2`,
      [req.params.id, token]
    );
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    await db.query('UPDATE photos SET caption = $1 WHERE id = $2', [caption || null, photo.id]);
    res.json({ ok: true, caption: caption || null });
  } catch (err) {
    console.error('[customer/photo caption] error:', err);
    res.status(500).json({ error: 'Could not save the caption. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/customer/request-revision?token=<access_token>
// Body: { feedback: "What I want changed..." }
// Saves the feedback on the most recent draft, flips customer status, emails Ken.
// ---------------------------------------------------------------------------
router.post('/request-revision', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });
    const feedback = (req.body.feedback || '').trim();
    if (!feedback) return res.status(400).json({ error: 'Please tell us what you would like changed.' });
    if (feedback.length > 5000) return res.status(400).json({ error: 'Feedback is too long (5000 character max).' });

    const customer = await db.queryOne(
      'SELECT id, name, email FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    const draft = await db.queryOne(
      `SELECT id, version FROM drafts WHERE customer_id = $1
       ORDER BY version DESC, created_at DESC LIMIT 1`,
      [customer.id]
    );
    if (!draft) return res.status(400).json({ error: 'No draft to request revision on yet.' });

    await db.query(
      `UPDATE drafts SET customer_feedback = $1, feedback_received_at = NOW(), status = 'revision_requested'
       WHERE id = $2`,
      [feedback, draft.id]
    );
    await db.query(`UPDATE customers SET status = 'revision_requested' WHERE id = $1`, [customer.id]);

    // Email Ken
    const subject = 'Revision request from ' + customer.name;
    const adminLink = 'https://www.bcsmemorybox.com/admin.html';
    const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#8b5a2b;">Revision request</h2>' +
'<p><strong>' + escapeHtml(customer.name) + '</strong> (' + escapeHtml(customer.email) + ') has requested a revision on their draft v' + draft.version + '.</p>' +
'<div style="background:#faf7f0;border-left:4px solid #8b5a2b;padding:16px 22px;margin:20px 0;white-space:pre-wrap;font-family:Georgia,serif;">' +
escapeHtml(feedback) +
'</div>' +
'<p><a href="' + adminLink + '" style="background:#8b5a2b;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Open admin dashboard</a></p>' +
'</div>';

    await sendEmail('kbakerbcs1@gmail.com', subject, html);

    res.json({ ok: true, message: 'Your revision request has been sent. Ken will work on it soon.' });
  } catch (err) {
    console.error('[customer/request-revision] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken if it keeps happening.' });
  }
});

// ---------------------------------------------------------------------------
// Helper: fetch the customer's current reviewable draft (the one they read).
// ---------------------------------------------------------------------------
async function currentReviewableDraft(customerId) {
  return db.queryOne(
    `SELECT id, version, revision_status, docx_storage_key, prev_docx_storage_key,
            (prev_markdown_content IS NOT NULL) AS can_undo
     FROM drafts
     WHERE customer_id = $1
       AND status IN ('delivered', 'approved', 'ready_for_review')
     ORDER BY version DESC, created_at DESC LIMIT 1`,
    [customerId]
  );
}

// ---------------------------------------------------------------------------
// POST /api/customer/revise?token=...   (multipart: field "audio")
// The customer SPEAKS a change. We store the clip and kick off the async
// revision (transcribe -> AI apply -> regenerate). Returns immediately; the
// page polls /me and shows what changed when it's done.
// ---------------------------------------------------------------------------
router.post('/revise', reviseUpload.single('audio'), async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const customer = await db.queryOne('SELECT id, status FROM customers WHERE access_token = $1', [token]);
    if (!customer) return res.status(404).json({ error: 'Account not found' });
    if (customer.status !== 'draft_ready') {
      return res.status(400).json({ error: 'You can make changes once your draft is ready to read.' });
    }

    const draft = await currentReviewableDraft(customer.id);
    if (!draft) return res.status(400).json({ error: 'No draft to change yet.' });
    if (draft.revision_status === 'working') {
      return res.json({ ok: true, working: true, message: 'A change is already being applied.' });
    }

    const audio = req.file;
    if (!audio) return res.status(400).json({ error: 'No audio was received. Please try recording your change again.' });

    const ext = (((audio.originalname || '').split('.').pop()) || (audio.mimetype || '').split('/').pop() || 'bin')
      .toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    const key = 'customers/' + customer.id + '/revisions/' + Date.now() + '-' + db.randomToken(6) + '.' + ext;
    await storage.uploadObject(key, audio.buffer, audio.mimetype);

    await db.query("UPDATE drafts SET revision_status = 'working', revision_error = NULL WHERE id = $1", [draft.id]);
    // Fire and forget — the page polls for the result.
    runRevisionAsync(customer.id, draft.id, key).catch((e) => console.error('[revise] async error: ' + e.message));

    res.json({ ok: true, working: true, message: 'Working on your change…' });
  } catch (err) {
    console.error('[customer/revise] error:', err);
    res.status(500).json({ error: 'Something went wrong starting your change. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/customer/keep-revision?token=...
// Customer is happy with the last voice change — commit it (drop the undo copy).
// ---------------------------------------------------------------------------
router.post('/keep-revision', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });
    const customer = await db.queryOne('SELECT id FROM customers WHERE access_token = $1', [token]);
    if (!customer) return res.status(404).json({ error: 'Account not found' });
    const draft = await currentReviewableDraft(customer.id);
    if (!draft) return res.status(400).json({ error: 'No draft found.' });

    // Best-effort cleanup of the superseded .docx.
    if (draft.prev_docx_storage_key) {
      try { await storage.deleteObject(draft.prev_docx_storage_key); } catch (e) { /* best effort */ }
    }
    await db.query(
      `UPDATE drafts SET revision_status = 'idle', last_change_summary = NULL,
         prev_markdown_content = NULL, prev_docx_storage_key = NULL,
         prev_interior_pdf_key = NULL, prev_cover_pdf_key = NULL, prev_page_count = NULL,
         revision_error = NULL
       WHERE id = $1`,
      [draft.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[customer/keep-revision] error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/customer/undo-revision?token=...
// Customer wants to undo the last voice change — restore the previous version.
// ---------------------------------------------------------------------------
router.post('/undo-revision', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });
    const customer = await db.queryOne('SELECT id FROM customers WHERE access_token = $1', [token]);
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    const draft = await db.queryOne(
      `SELECT id, prev_markdown_content, prev_docx_storage_key, docx_storage_key
       FROM drafts
       WHERE customer_id = $1 AND status IN ('delivered','approved','ready_for_review')
       ORDER BY version DESC, created_at DESC LIMIT 1`,
      [customer.id]
    );
    if (!draft || draft.prev_markdown_content == null) {
      return res.status(400).json({ error: 'There is no change to undo.' });
    }
    const supersededDocx = draft.docx_storage_key;
    await db.query(
      `UPDATE drafts SET
         markdown_content = prev_markdown_content,
         docx_storage_key = prev_docx_storage_key,
         interior_pdf_key = COALESCE(prev_interior_pdf_key, interior_pdf_key),
         cover_pdf_key    = COALESCE(prev_cover_pdf_key, cover_pdf_key),
         page_count       = COALESCE(prev_page_count, page_count),
         prev_markdown_content = NULL, prev_docx_storage_key = NULL,
         prev_interior_pdf_key = NULL, prev_cover_pdf_key = NULL, prev_page_count = NULL,
         last_change_summary = NULL, revision_status = 'idle', revision_error = NULL
       WHERE id = $1`,
      [draft.id]
    );
    if (supersededDocx) { try { await storage.deleteObject(supersededDocx); } catch (e) { /* best effort */ } }
    res.json({ ok: true });
  } catch (err) {
    console.error('[customer/undo-revision] error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/customer/approve-book?token=...
// The customer approves their memoir as final. This is their commitment.
// Locks the draft, marks the customer 'approved', and notifies Ken (until the
// automatic print handoff is built).
// ---------------------------------------------------------------------------
router.post('/approve-book', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });
    const customer = await db.queryOne('SELECT id, name, email, status, plan FROM customers WHERE access_token = $1', [token]);
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    const draft = await currentReviewableDraft(customer.id);
    if (!draft) return res.status(400).json({ error: 'There is no book to approve yet.' });
    if (draft.revision_status === 'working') {
      return res.status(400).json({ error: 'Please wait for your current change to finish, then approve.' });
    }

    // Idempotency guard: if this book is already approved, don't run the whole
    // approve + auto-order + notify flow again. Protects against a double-click
    // or a retry landing here a second time (belt-and-suspenders with the
    // atomic order-claim in printOrder — either one alone prevents a double order).
    if (customer.status === 'approved') {
      return res.json({ ok: true, alreadyApproved: true, message: 'Your book is already approved — you’re all set.' });
    }

    // Save the shipping address for the included hardcover, if one was provided
    // with the approval (collected in the approval step for hardcover/legacy plans).
    const ship = (req.body && req.body.shipping) || null;
    if (ship && typeof ship === 'object') {
      const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
      const name = s(ship.name, 120), a1 = s(ship.address1, 200), city = s(ship.city, 120), zip = s(ship.zip, 40);
      if (name && a1 && city && zip) {
        await db.query(
          `UPDATE customers SET ship_name=$2, ship_address1=$3, ship_address2=$4, ship_city=$5,
             ship_state=$6, ship_zip=$7, ship_country=$8, ship_phone=$9 WHERE id = $1`,
          [customer.id, name, a1, s(ship.address2, 120), city, s(ship.state, 80), zip,
           s(ship.country, 80) || 'US', s(ship.phone, 40)]
        );
      }
    }

    await db.query(
      "UPDATE drafts SET status = 'approved', approved_at = NOW(), revision_status = 'idle' WHERE id = $1",
      [draft.id]
    );
    await db.query("UPDATE customers SET status = 'approved', approved_at = NOW() WHERE id = $1", [customer.id]);

    // Fully-automatic hardcover ordering. If Lulu is configured and everything
    // needed is in place, this places the print order with no touch from Ken.
    // Otherwise it returns { ordered:false, reason } and we email Ken as before.
    let order = { ordered: false, reason: 'unknown' };
    try {
      order = await printOrder.autoOrderOnApproval(customer, draft);
    } catch (e) {
      console.error('[approve-book] auto-order threw (falling back): ' + e.message);
    }

    try {
      const adminLink = 'https://www.bcsmemorybox.com/admin.html';
      const ordersLink = 'https://www.bcsmemorybox.com/admin.html#print-orders';
      let subject, html;
      if (order.ordered) {
        // The order was placed automatically.
        subject = '📖 Ordered ' + customer.name + '’s hardcover automatically';
        html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#8b5a2b;">Hardcover ordered — nothing for you to do 📖</h2>' +
'<p><strong>' + escapeHtml(customer.name) + '</strong> (' + escapeHtml(customer.email) + ') approved their memoir (v' + draft.version + '), and I placed their hardcover order with Lulu automatically.</p>' +
'<p>Total <strong>$' + escapeHtml(String(order.total)) + ' ' + escapeHtml(order.currency || 'USD') + '</strong>' + (order.luluId ? ' · Lulu job <strong>' + escapeHtml(order.luluId) + '</strong>' : '') + (order.env === 'sandbox' ? ' · <em>sandbox test</em>' : '') + '.</p>' +
'<p>It won’t go to the printer for about 24 hours, so you have a window to stop it if anything looks wrong. To cancel: open your dashboard, go to <strong>Print Orders</strong>, and press <strong>Cancel order</strong> on this one. Otherwise Lulu prints and ships it to the customer automatically — you don’t need to do anything.</p>' +
'<p><a href="' + ordersLink + '" style="background:#8b5a2b;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Open Print Orders</a></p>' +
'<p style="color:#8b5a2b;margin-top:24px;">— Bullet 🐶</p>' +
'</div>';
      } else {
        // Fall back to the manual "ready to print" notice, with a short note on why.
        subject = '✅ ' + customer.name + ' approved their book — ready to print';
        html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#8b5a2b;">A customer approved their book</h2>' +
'<p><strong>' + escapeHtml(customer.name) + '</strong> (' + escapeHtml(customer.email) + ') read their memoir, made any changes they wanted, and approved it as final (draft v' + draft.version + ').</p>' +
'<p>It is ready to be printed.</p>' +
'<p style="color:#7a726a;font-size:13px;">' + escapeHtml(autoOrderNote(order)) + '</p>' +
'<p><a href="' + adminLink + '" style="background:#8b5a2b;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Open admin dashboard</a></p>' +
'<p style="color:#8b5a2b;margin-top:24px;">— Bullet 🐶</p>' +
'</div>';
      }
      await sendEmail('kbakerbcs1@gmail.com', subject, html);
    } catch (e) { console.error('[approve-book] could not email Ken: ' + e.message); }

    res.json({ ok: true, message: 'Your book is approved.' });
  } catch (err) {
    console.error('[customer/approve-book] error:', err);
    res.status(500).json({ error: 'Something went wrong approving your book. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/customer/order-book?token=<access_token>
// Body: { name, address1, address2, city, state, zip, country, copies, notes }
// V1: emails Ken the customer's hardcover book request; Ken confirms payment
// and places the order on Lulu (flow proven manually). No charge taken here.
// ---------------------------------------------------------------------------
router.post('/order-book', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const customer = await db.queryOne(
      'SELECT id, name, email FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    const b = req.body || {};
    const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
    const shipName = clean(b.name, 120);
    const address1 = clean(b.address1, 200);
    const address2 = clean(b.address2, 120);
    const city     = clean(b.city, 120);
    const state    = clean(b.state, 80);
    const zip      = clean(b.zip, 40);
    const country  = clean(b.country, 80) || 'USA';
    const notes    = clean(b.notes, 1000);
    let copies = parseInt(b.copies, 10);
    if (!(copies >= 1)) copies = 1;
    if (copies > 50) copies = 50;

    if (!shipName || !address1 || !city || !state || !zip) {
      return res.status(400).json({ error: 'Please fill in your name and full shipping address.' });
    }

    const priceNote = copies === 1 ? '$99' : (copies + ' x $99 = $' + (copies * 99));
    const subject = 'Hardcover book order from ' + (customer.name || shipName);
    const adminLink = 'https://www.bcsmemorybox.com/admin.html';
    const rows = [
      ['Customer', (customer.name || '') + ' (' + customer.email + ')'],
      ['Ship to', shipName],
      ['Address', address1 + (address2 ? ', ' + address2 : '')],
      ['City / State / Zip', city + ', ' + state + ' ' + zip],
      ['Country', country],
      ['Copies', copies + '  (' + priceNote + ')'],
    ];
    if (notes) rows.push(['Notes', notes]);
    const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
'<h2 style="color:#8b5a2b;">Hardcover book order</h2>' +
'<p><strong>' + escapeHtml(customer.name || shipName) + '</strong> would like to order <strong>' + copies + '</strong> hardcover ' + (copies === 1 ? 'copy' : 'copies') + ' of their memoir.</p>' +
'<table style="border-collapse:collapse;margin:16px 0;">' +
rows.map((r) => '<tr><td style="padding:4px 14px 4px 0;color:#8b5a2b;vertical-align:top;"><strong>' + escapeHtml(r[0]) + '</strong></td><td style="padding:4px 0;">' + escapeHtml(r[1]) + '</td></tr>').join('') +
'</table>' +
'<p style="color:#5a4a3a;">Next: confirm details + payment with the customer, then place it on Lulu (template: 8.5x11 hardcover casewrap, color).</p>' +
'<p><a href="' + adminLink + '" style="background:#8b5a2b;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Open admin dashboard</a></p>' +
'</div>';

    await sendEmail('kbakerbcs1@gmail.com', subject, html);
    res.json({ ok: true, message: "Your book request is in! Ken will email you to confirm the details and arrange payment." });
  } catch (err) {
    console.error('[customer/order-book] error:', err);
    res.status(500).json({ error: 'Something went wrong sending your request. Please try again, or email Ken directly at hello@bcsmemorybox.com.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/customer/request-link
// Body: { email }
// A returning customer who lost their story link asks for it again. We email
// the link to the address on file. Always responds the same way whether or not
// the email matches an account, so it can't be used to discover who has one.
// ---------------------------------------------------------------------------
router.post('/request-link', async (req, res) => {
  const GENERIC = 'If that email has a Memory Box story, we just sent the link to it. Please check your inbox (and your spam folder).';
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const customer = await db.queryOne(
      'SELECT name, access_token, paid_at FROM customers WHERE email = $1',
      [email]
    );

    // Only paying customers have a story page to return to.
    if (customer && customer.paid_at) {
      try {
        await mailer.sendStoryLink(email, customer.name, customer.access_token, false);
        console.log('[customer/request-link] link re-sent to ' + email);
      } catch (mailErr) {
        // Log only — still return the generic message so the endpoint never
        // reveals whether an email is registered.
        console.error('[customer/request-link] email send failed:', mailErr.message);
      }
    } else {
      console.log('[customer/request-link] no paid account for ' + email + ' (generic response)');
    }

    res.json({ ok: true, message: GENERIC });
  } catch (err) {
    console.error('[customer/request-link] error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

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
      // Admin/"Bullet" alerts also go to Kelly (partner); customer mail is unaffected.
      to: to === 'kbakerbcs1@gmail.com' ? ['kbakerbcs1@gmail.com', 'kelly.wrightn@yahoo.com'] : to,
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

// Short, plain-English note explaining why an automatic hardcover order didn't
// happen, shown to Ken in the fallback "ready to print" email.
function autoOrderNote(order) {
  switch (order && order.reason) {
    case 'dry_run':        return 'TEST MODE: I checked Lulu for real — this book would cost $' + (order.total || '?') + ' ' + (order.currency || 'USD') + ' and the cover size checks out. No order was placed and nothing was charged. Flip LULU_LIVE_ORDERS=true in Render when you’re ready to print for real.';
    case 'lulu_disabled':  return 'Automatic printing isn’t switched on yet (Lulu keys not set) — place this one on Lulu as usual.';
    case 'digital_plan':   return 'This customer is on the digital plan, so there’s no hardcover to print.';
    case 'no_print_pdf':   return 'The print-ready PDF isn’t generated for this book yet, so I couldn’t auto-order it.';
    case 'no_address':     return 'No shipping address is on file yet, so I couldn’t auto-order it.';
    case 'already_ordered':return 'A hardcover order for this book already exists.';
    case 'cost_anomaly':   return 'Lulu’s price came back unexpectedly high ($' + (order.total || '?') + '), so I held off — please review before printing.';
    case 'error':          return 'The automatic order hit a snag (' + (order.error || 'unknown') + '). IMPORTANT: it may or may not have reached Lulu. Before placing anything by hand, open Print Orders (press Refresh) or check your Lulu account first, so you don’t order it twice.';
    default:               return 'Placed for manual printing.';
  }
}

// ---------------------------------------------------------------------------
// POST /api/customer/finish-follow-ups?token=<access_token>
// The storyteller has recorded their answers to the follow-up questions and is
// done. Re-run the pipeline: their spoken answers get transcribed and woven in,
// producing the richer final draft. Returns immediately.
// ---------------------------------------------------------------------------
router.post('/finish-follow-ups', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });
    const customer = await db.queryOne(
      'SELECT id, status FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });
    if (customer.status === 'processing') {
      return res.json({ ok: true, alreadyProcessing: true, message: 'Your book is already being finished.' });
    }
    // Mark the follow-up round done BEFORE re-running so the pipeline FINALIZES the
    // book (weaving in any answers already given) instead of regenerating a fresh
    // batch of questions and looping the customer back into follow_up. (Answered
    // Q&A is rebuilt from the DB every run, so answers are still woven in.) Mirrors
    // the skip-follow-ups and reopen-recording paths, which set this for the same reason.
    await db.query("UPDATE customers SET follow_up_done = TRUE WHERE id = $1", [customer.id]);
    runCleanupPipeline(customer.id).catch(function (err) { console.error('[finish-follow-ups] pipeline crashed:', err); });
    res.json({ ok: true, message: "Thank you! We're weaving your answers in now — we'll email you when your book is ready." });
  } catch (err) {
    console.error('[customer/finish-follow-ups] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken if it keeps happening.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/customer/skip-follow-ups?token=<access_token>
// The storyteller would rather finish the book as-is. We keep the first draft,
// mark the follow-up round done, flip to draft_ready, and notify Ken.
// ---------------------------------------------------------------------------
router.post('/skip-follow-ups', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });
    const customer = await db.queryOne(
      'SELECT id, email, name, access_token FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    const draft = await db.queryOne(
      `SELECT id FROM drafts WHERE customer_id = $1 ORDER BY version DESC, created_at DESC LIMIT 1`,
      [customer.id]
    );
    await db.query("UPDATE customers SET status = 'draft_ready', follow_up_done = TRUE WHERE id = $1", [customer.id]);
    if (draft) { try { await emailAdminDraftReady(customer, draft.id); } catch (e) { console.error('[skip-follow-ups] could not email Ken:', e.message); } }

    res.json({ ok: true, message: 'Your book is finished and on its way to review.' });
  } catch (err) {
    console.error('[customer/skip-follow-ups] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken if it keeps happening.' });
  }
});

module.exports = router;


// ----------------------------------------------------------------------------
// POST /api/customer/undo-approval?token=<access_token>
// A customer-safe "changed your mind?" within ~24h of approving. Cancels the
// auto-placed Lulu order (if it hasn't entered production yet) and returns the
// customer to the reviewing state so they can edit and re-approve. If Lulu has
// already started printing, we do NOT revert and point them to email Ken.
// (Registered after module.exports, same as the routes below — the router is
// exported by reference, so these are still part of it.)
// ----------------------------------------------------------------------------
router.post('/undo-approval', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });
    const customer = await db.queryOne(
      'SELECT id, status FROM customers WHERE access_token = $1', [token]);
    if (!customer) return res.status(404).json({ error: 'Account not found' });
    if (customer.status !== 'approved') {
      return res.json({ ok: true, reverted: false, message: 'Your book isn’t approved right now, so there’s nothing to undo.' });
    }

    // Cancel the most recent print order for this customer, if one is live.
    const job = await db.queryOne(
      "SELECT id, status, lulu_print_job_id FROM print_jobs WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1",
      [customer.id]
    );
    if (job && job.status === 'submitted' && job.lulu_print_job_id) {
      try {
        await lulu.cancelPrintJob(job.lulu_print_job_id);
      } catch (e) {
        console.error('[undo-approval] Lulu cancel refused for customer ' + customer.id + ': ' + e.message);
        return res.status(409).json({
          error: 'Your book may already be printing, so I couldn’t stop it automatically. Please email Ken right away (hello@bcsmemorybox.com) and he’ll sort it out for you.'
        });
      }
      await db.query("UPDATE print_jobs SET status='canceled', last_lulu_status='CANCELED', updated_at=NOW() WHERE id=$1", [job.id]);
    } else if (job && (job.status === 'reserving' || job.status === 'created' || job.status === 'validated')) {
      await db.query("UPDATE print_jobs SET status='canceled', updated_at=NOW() WHERE id=$1", [job.id]);
    }

    // Return the customer + draft to the reviewing state (edit / re-approve).
    await db.query("UPDATE customers SET status='draft_ready', approved_at=NULL, print_ordered_at=NULL WHERE id=$1", [customer.id]);
    await db.query("UPDATE drafts SET status='delivered', approved_at=NULL WHERE customer_id=$1 AND status='approved'", [customer.id]);

    return res.json({ ok: true, reverted: true, message: 'Done — your book is open for changes again.' });
  } catch (err) {
    console.error('[customer/undo-approval] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken.' });
  }
});

// ----------------------------------------------------------------------------
// POST /api/customer/reopen-recording?token=<access_token>
// Lets a customer who already has a finished (delivered) or draft-ready memoir
// go back into recording mode to add more stories. Flips status back to
// 'recording'. Existing recordings + transcripts are preserved; when they click
// "I'm done" again, the cleanup pipeline re-runs over everything and produces an
// updated draft for the admin to review and re-deliver.
// NOTE: registered after module.exports on purpose — the router is exported by
// reference, so routes added here are still part of the exported router.
// ----------------------------------------------------------------------------
router.post('/reopen-recording', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const customer = await db.queryOne(
      'SELECT id, status, paid_at FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });
    if (!customer.paid_at) {
      return res.status(403).json({ error: 'Payment is required before recording.' });
    }

    // Reopen only from a finished state. From other states this is a safe no-op,
    // so we never interrupt an in-flight processing run or an unpaid account.
    if (customer.status === 'delivered' || customer.status === 'draft_ready' || customer.status === 'revision_requested') {
      await db.query("UPDATE customers SET status = 'recording' WHERE id = $1", [customer.id]);
      return res.json({ ok: true, reopened: true, message: 'You can add more to your story now.' });
    }
    // Sitting on the follow-up questions and want to record a WHOLE NEW story
    // instead of just answering? Let them straight back into recording.
    // We also mark follow_up_done so the re-run finalizes to a draft rather than
    // generating a SECOND batch of questions on top of the existing ones (the
    // questions table is insert-only, so a second batch would stack up and the
    // customer would look stuck in a loop). Answers they already gave are still
    // woven in — cleanup reads answered Q&A from the database on every run,
    // regardless of this flag.
    if (customer.status === 'follow_up') {
      await db.query("UPDATE customers SET status = 'recording', follow_up_done = TRUE WHERE id = $1", [customer.id]);
      return res.json({ ok: true, reopened: true, message: 'You can add more to your story now.' });
    }
    if (customer.status === 'processing') {
      return res.json({ ok: true, reopened: false, message: 'Your memoir is being prepared right now. Once it is ready you can add more.' });
    }
    // Already recording (or revision_requested / error) — just let them in.
    return res.json({ ok: true, reopened: false, message: 'You can add to your story now.' });
  } catch (err) {
    console.error('[customer/reopen-recording] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken if it keeps happening.' });
  }
});


// ----------------------------------------------------------------------------
// GET /api/customer/recording-audio?token=<access_token>&id=<recording_id>
// Streams one of the customer's OWN recordings back so they can listen to it
// on their story page. Ownership is enforced: the recording must belong to the
// customer that owns the access token. (Registered after module.exports on
// purpose — same reason as reopen-recording above.)
// ----------------------------------------------------------------------------
router.get('/recording-audio', async (req, res) => {
  try {
    const token = req.query.token;
    const id = req.query.id;
    if (!token) return res.status(401).json({ error: 'Missing access token' });
    if (!id) return res.status(400).json({ error: 'Missing recording id' });

    const customer = await db.queryOne(
      'SELECT id FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    const recording = await db.queryOne(
      'SELECT storage_key, original_filename FROM recordings WHERE id = $1 AND customer_id = $2',
      [id, customer.id]
    );
    if (!recording) return res.status(404).json({ error: 'Recording not found' });

    const { stream, contentType, contentLength } = await storage.getObjectStream(recording.storage_key);
    res.setHeader('Content-Type', contentType || 'audio/mpeg');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    stream.pipe(res);
  } catch (err) {
    console.error('[customer/recording-audio] error:', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again, or email Ken if it keeps happening.' });
  }
});

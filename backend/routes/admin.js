// Admin routes — Ken's dashboard for managing customers, recordings, drafts.
// Simple auth: password from env var ADMIN_PASSWORD, session token stored in
// the admin_sessions table.

const express = require('express');
const db = require('../lib/db');
const storage = require('../lib/storage');
const mailer = require('../lib/mailer');
const lulu = require('../lib/lulu');
const crypto = require('crypto');
const QRCode = require('qrcode');

// Where the public listen page lives (the QR points here).
const FRONTEND_BASE = process.env.FRONTEND_BASE_URL || 'https://www.bcsmemorybox.com';

const router = express.Router();
router.use(express.json());

const SESSION_TTL_DAYS = 7;

// ---------------------------------------------------------------------------
// Login throttle — a stranger who finds the login page must not be able to
// guess the admin password at machine speed. Single instance, so an in-memory
// Map is enough. Keyed on the REAL client IP (rightmost X-Forwarded-For entry,
// the hop Render appended — the leftmost is client-spoofable).
// ---------------------------------------------------------------------------
const _loginHits = new Map(); // ip -> [timestamps]
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAX = 8;                     // attempts per window per IP
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress || 'unknown');
}
function loginLimiter(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (_loginHits.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (recent.length >= LOGIN_MAX) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Please wait a few minutes, then try again.' });
  }
  recent.push(now);
  _loginHits.set(ip, recent);
  // Best-effort tidy so the Map doesn't grow forever.
  if (_loginHits.size > 5000) { for (const k of _loginHits.keys()) { _loginHits.delete(k); break; } }
  next();
}

// ---------------------------------------------------------------------------
// Auth middleware — every admin endpoint except /login goes through this
// ---------------------------------------------------------------------------
async function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-session'] || req.query.session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = await db.queryOne(
    `SELECT token, expires_at FROM admin_sessions
     WHERE token = $1 AND expires_at > NOW()`,
    [token]
  );
  if (!session) return res.status(401).json({ error: 'Session expired' });
  next();
}

// ---------------------------------------------------------------------------
// POST /api/admin/login
// Body: { password: "..." }
// Returns: { ok, sessionToken, expiresAt }
// ---------------------------------------------------------------------------
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const password = req.body.password || '';
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) {
      return res.status(500).json({ error: 'ADMIN_PASSWORD env var not configured' });
    }
    // Constant-time compare to resist timing attacks
    const crypto = require('crypto');
    const a = Buffer.from(password);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Wrong password' });
    }

    const sessionToken = db.randomToken(32);
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    await db.query(
      `INSERT INTO admin_sessions (token, expires_at) VALUES ($1, $2)`,
      [sessionToken, expiresAt]
    );

    // Best-effort: clear out any expired sessions so the table stays tidy
    db.query('DELETE FROM admin_sessions WHERE expires_at < NOW()').catch(()=>{});

    res.json({ ok: true, sessionToken, expiresAt });
  } catch (err) {
    console.error('[admin/login] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/logout
// ---------------------------------------------------------------------------
router.post('/logout', async (req, res) => {
  try {
    const token = req.headers['x-admin-session'] || req.body.session;
    if (token) {
      await db.query('DELETE FROM admin_sessions WHERE token = $1', [token]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/customers
// Returns a summary list of all customers with recording/draft counts
// ---------------------------------------------------------------------------
router.get('/customers', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        c.id,
        c.email,
        c.name,
        c.plan,
        c.status,
        c.paid_at,
        c.created_at,
        c.updated_at,
        (SELECT COUNT(*) FROM recordings r WHERE r.customer_id = c.id) AS recording_count,
        (SELECT COUNT(*) FROM drafts d WHERE d.customer_id = c.id) AS draft_count
      FROM customers c
      WHERE c.deleted_at IS NULL
      ORDER BY c.created_at DESC
    `);
    res.json({ ok: true, customers: rows });
  } catch (err) {
    console.error('[admin/customers] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/customer/:id
// Full per-customer detail: customer record + all recordings + all drafts
// ---------------------------------------------------------------------------
router.get('/customer/:id', requireAdmin, async (req, res) => {
  try {
    const customer = await db.queryOne(
      `SELECT id, email, name, plan, access_token, status, paid_at, created_at, updated_at,
              stripe_customer_id, stripe_payment_intent_id
       FROM customers WHERE id = $1`,
      [req.params.id]
    );
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { rows: recordings } = await db.query(
      `SELECT id, storage_key, original_filename, size_bytes, duration_seconds,
              transcript_status, transcript_error, created_at,
              LENGTH(transcript) AS transcript_length
       FROM recordings
       WHERE customer_id = $1
       ORDER BY created_at ASC`,
      [req.params.id]
    );

    const { rows: drafts } = await db.query(
      `SELECT id, version, status, approved_at, delivered_at, created_at,
              LENGTH(markdown_content) AS content_length, docx_storage_key
       FROM drafts
       WHERE customer_id = $1
       ORDER BY version DESC`,
      [req.params.id]
    );

    const { rows: photos } = await db.query(
      `SELECT id, original_filename, size_bytes, content_type, caption, created_at
       FROM photos
       WHERE customer_id = $1
       ORDER BY created_at ASC`,
      [req.params.id]
    );

    const { rows: voiceClips } = await db.query(
      `SELECT id, recording_id, public_token, person_name, label, created_at
         FROM voice_clips
        WHERE customer_id = $1
        ORDER BY created_at ASC`,
      [req.params.id]
    );

    res.json({ ok: true, customer, recordings, drafts, photos, voiceClips });
  } catch (err) {
    console.error('[admin/customer/:id] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/customer/:id
// Permanently removes a customer along with all of their recordings and drafts.
// The recordings/drafts rows are removed automatically by the database's
// SOFT-delete only (sets deleted_at): the customer disappears from the
// dashboard but NOTHING is destroyed — recordings, drafts, photos, and all R2
// audio are kept, so a mistaken delete is fully recoverable. Requires an email
// confirmation. Used for clearing test accounts before launch.
// ---------------------------------------------------------------------------
router.delete('/customer/:id', requireAdmin, async (req, res) => {
  try {
    const customer = await db.queryOne(
      'SELECT id, email, name, paid_at FROM customers WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (!customer) return res.status(404).json({ error: 'Customer not found (or already removed).' });

    // SAFETY GUARD: require the caller to confirm by passing the customer's exact
    // email (?confirm=<email> or body.confirmEmail). Prevents a mis-clicked id or
    // a stray retry from ever removing the wrong account.
    const confirm = String((req.query.confirm || (req.body && req.body.confirmEmail) || '')).trim().toLowerCase();
    if (confirm !== String(customer.email || '').trim().toLowerCase()) {
      return res.status(400).json({ error: 'Confirmation email did not match — nothing was removed.' });
    }

    // SOFT-DELETE ONLY — never hard-delete the row or erase the customer's R2
    // audio. That audio is an elderly person's irreplaceable life story, and a
    // permanent delete has no undo. Setting deleted_at hides them from the
    // dashboard while keeping every recording, draft, and file fully recoverable.
    // (A deliberate, reviewed purge of truly-unwanted rows can happen later.)
    await db.query('UPDATE customers SET deleted_at = NOW() WHERE id = $1', [req.params.id]);
    console.log('[admin/customer/delete] SOFT-deleted ' + customer.email + ' (' + customer.id + ') — recordings + audio KEPT, fully recoverable');
    res.json({ ok: true, deleted: true, softDeleted: true, recoverable: true, email: customer.email });
  } catch (err) {
    console.error('[admin/customer/delete] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/recording/:id/url
// Returns a temporary download URL for a recording (so Ken can listen to it)
// V1: just stream it through the server. Later we can presign R2 URLs.
// ---------------------------------------------------------------------------
router.get('/recording/:id/download', requireAdmin, async (req, res) => {
  try {
    const recording = await db.queryOne(
      'SELECT storage_key, original_filename FROM recordings WHERE id = $1',
      [req.params.id]
    );
    if (!recording) return res.status(404).json({ error: 'Recording not found' });

    const { stream, contentType, contentLength } = await storage.getObjectStream(recording.storage_key);
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Disposition', 'attachment; filename="' + (recording.original_filename || 'recording') + '"');
    stream.pipe(res);
  } catch (err) {
    console.error('[admin/recording/download] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/photo/:id/view
// Streams a customer photo inline so Ken can see it in the dashboard. The
// admin session token is passed as ?session=... so it works in an <img> tag.
// ---------------------------------------------------------------------------
router.get('/photo/:id/view', requireAdmin, async (req, res) => {
  try {
    const photo = await db.queryOne(
      'SELECT storage_key, content_type FROM photos WHERE id = $1',
      [req.params.id]
    );
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    const { stream, contentType, contentLength } = await storage.getObjectStream(photo.storage_key);
    res.setHeader('Content-Type', photo.content_type || contentType || 'image/jpeg');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    stream.pipe(res);
  } catch (err) {
    console.error('[admin/photo/view] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});


// ---------------------------------------------------------------------------
// GET /api/admin/draft/:id
// Returns the draft including its markdown content (for Ken to read/edit)
// ---------------------------------------------------------------------------
router.get('/draft/:id', requireAdmin, async (req, res) => {
  try {
    const draft = await db.queryOne(
      `SELECT d.*, c.name AS customer_name, c.email AS customer_email, c.status AS customer_status
       FROM drafts d
       JOIN customers c ON c.id = d.customer_id
       WHERE d.id = $1`,
      [req.params.id]
    );
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    res.json({ ok: true, draft });
  } catch (err) {
    console.error('[admin/draft/get] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/admin/draft/:id
// Body: { markdown_content: "..." }
// Save Ken's edits to the draft markdown (doesn't re-render docx — that happens on approve)
// ---------------------------------------------------------------------------
router.put('/draft/:id', requireAdmin, async (req, res) => {
  try {
    const newContent = req.body.markdown_content;
    if (typeof newContent !== 'string') return res.status(400).json({ error: 'markdown_content required' });
    const updated = await db.queryOne(
      `UPDATE drafts SET markdown_content = $1 WHERE id = $2 RETURNING id`,
      [newContent, req.params.id]
    );
    if (!updated) return res.status(404).json({ error: 'Draft not found' });
    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[admin/draft/put] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/draft/:id/approve
// Regenerates the .docx from current markdown, marks draft approved, sets
// customer status to delivered, emails the customer with a download link.
// ---------------------------------------------------------------------------
const { renderMemoirDocx } = require('../lib/cleanup');

router.post('/draft/:id/approve', requireAdmin, async (req, res) => {
  try {
    const draft = await db.queryOne(
      `SELECT d.*, c.name AS customer_name, c.email AS customer_email, c.access_token
       FROM drafts d
       JOIN customers c ON c.id = d.customer_id
       WHERE d.id = $1`,
      [req.params.id]
    );
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (!draft.markdown_content) return res.status(400).json({ error: 'Draft has no content yet' });

    // 1. Re-render .docx from possibly-edited markdown
    const buffer = await renderMemoirDocx(draft.markdown_content);
    const newKey = 'customers/' + draft.customer_id + '/drafts/approved-v' + draft.version + '-' + Date.now() + '.docx';
    await storage.uploadObject(
      newKey, buffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    // 2. Mark draft approved + delivered (single step for V1)
    await db.query(
      `UPDATE drafts
       SET status = 'delivered',
           docx_storage_key = $1,
           approved_at = NOW(),
           delivered_at = NOW()
       WHERE id = $2`,
      [newKey, draft.id]
    );

    // 3. Bump customer status to delivered
    await db.query(`UPDATE customers SET status = 'delivered' WHERE id = $1`, [draft.customer_id]);

    // 4. Email the customer with a download link (link points to their portal page)
    const portalUrl = 'https://www.bcsmemorybox.com/yourstory.html?token=' + encodeURIComponent(draft.access_token);
    const subject = 'Your Memory Box memoir is ready';
    const html =
'<div style="font-family:Georgia,serif;max-width:600px;line-height:1.65;color:#2a2520;background:#fff;padding:32px;border-radius:8px;">' +
'<p>Hi ' + escapeHtml(draft.customer_name) + ',</p>' +
'<p>Your memoir is ready. I have read through what the system put together from your recordings and made any small touches I wanted to add.</p>' +
'<p style="margin-top:28px;">' +
'<a href="' + portalUrl + '" style="background:#8b5a2b;color:#fff;padding:14px 28px;text-decoration:none;border-radius:4px;display:inline-block;font-family:Georgia,serif;font-weight:bold;">Open your memoir</a>' +
'</p>' +
'<p style="font-size:15px;color:#6b5d4f;margin-top:6px;">If the button above does not open, copy and paste this web address into your web browser:<br>' +
'<a href="' + portalUrl + '" style="color:#8b5a2b;word-break:break-all;">' + portalUrl + '</a></p>' +
'<p>From your story page you can download the Word document and keep it for your family.</p>' +
'<p>If anything reads wrong or you want me to change something, click <strong>Request a revision</strong> from the same page. Your purchase includes two rounds of revisions.</p>' +
'<p style="margin-top:28px;">— Ken Baker<br>BCS Memory Box</p>' +
'</div>';
    await sendEmail(draft.customer_email, subject, html);

    res.json({ ok: true, delivered: true });
  } catch (err) {
    console.error('[admin/draft/approve] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/comp-customer   { name, email }
// Creates a FREE (comped) customer — already in 'recording' status, no Stripe
// payment — and emails them their story link. Used for beta testers and gifts.
// Comped accounts are recognizable later by having paid_at set but no
// stripe_payment_intent_id.
// ---------------------------------------------------------------------------
router.post('/comp-customer', requireAdmin, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const partnerName = (req.body.partnerName || '').trim(); // if set → a COUPLE account
    const isCouple = !!partnerName;
    if (!name) return res.status(400).json({ error: 'Please enter a name.' });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const existing = await db.queryOne(
      'SELECT id, access_token, is_couple FROM customers WHERE email = $1', [email]);
    if (existing) {
      const url = 'https://www.bcsmemorybox.com/yourstory.html?token=' + encodeURIComponent(existing.access_token);
      // If a partner name is given, UPGRADE the existing account to a couple
      // (reuse it) instead of erroring — so an existing tester can become a
      // couple in one click, and their link is re-sent.
      if (isCouple) {
        await db.query(
          'UPDATE customers SET is_couple = TRUE, partner_name = $1 WHERE id = $2',
          [partnerName, existing.id]
        );
        let reSent = true;
        try { await mailer.sendStoryLink(email, name, existing.access_token, true); }
        catch (e) { reSent = false; console.error('[admin/comp-customer] couple upgrade re-send failed:', e.message); }
        return res.json({
          ok: true, upgraded: true, isCouple: true, portalUrl: url, emailed: reSent,
          message: reSent
            ? ('Updated ' + name + ' & ' + partnerName + ' to a couple account — link re-sent to ' + email + '.')
            : ('Updated ' + name + ' & ' + partnerName + ' to a couple account, but the email did not send. Share this link: ' + url),
        });
      }
      return res.status(409).json({ error: 'A customer with that email already exists.', portalUrl: url });
    }

    const accessToken = db.randomToken(24);
    const created = await db.queryOne(
      `INSERT INTO customers (email, name, access_token, status, paid_at, is_couple, partner_name)
       VALUES ($1, $2, $3, 'recording', NOW(), $4, $5)
       RETURNING id, access_token`,
      [email, name, accessToken, isCouple, partnerName || null]);

    const portalUrl = 'https://www.bcsmemorybox.com/yourstory.html?token=' + encodeURIComponent(created.access_token);

    let emailed = true;
    try {
      await mailer.sendStoryLink(email, name, created.access_token, true);
    } catch (mailErr) {
      emailed = false;
      console.error('[admin/comp-customer] welcome email failed:', mailErr.message);
    }

    console.log('[admin/comp-customer] created free tester ' + email + (emailed ? ' (emailed)' : ' (email FAILED)'));
    res.json({
      ok: true,
      customerId: created.id,
      portalUrl: portalUrl,
      emailed: emailed,
      isCouple: isCouple,
      message: emailed
        ? ('Added ' + (isCouple ? (name + ' & ' + partnerName + ' as a couple tester') : (name + ' as a free tester')) + ' — welcome email sent to ' + email + '.')
        : ('Added ' + (isCouple ? (name + ' & ' + partnerName) : name) + ', but the welcome email did not send. Share this link with them directly: ' + portalUrl),
    });
  } catch (err) {
    console.error('[admin/comp-customer] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
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
      from: 'BCS Memory Box <ops@bcsmemorybox.com>',
      to: to,
      reply_to: 'hello@bcsmemorybox.com',
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

// ===========================================================================
// "THE VOICE" — QR-in-the-book voice clips
// ---------------------------------------------------------------------------
// A voice clip is a public, shareable link to ONE of a customer's recordings.
// Ken generates one, we print its QR inside the hardcover, and family members
// scan it to hear the person in their own voice. See routes/voice.js for the
// public (unauthenticated) listen endpoints.
// ===========================================================================

function firstName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || '';
}

// POST /api/admin/voice-clip
// Body: { recording_id, person_name?, label? }
// Creates (or returns the existing) voice clip for a recording and hands back
// the public listen URL. person_name defaults to the customer's first name.
router.post('/voice-clip', requireAdmin, async (req, res) => {
  try {
    const recordingId = req.body.recording_id;
    if (!recordingId) return res.status(400).json({ error: 'Missing recording_id' });

    const rec = await db.queryOne(
      `SELECT r.id, r.customer_id, c.name AS customer_name
         FROM recordings r JOIN customers c ON c.id = r.customer_id
        WHERE r.id = $1`,
      [recordingId]
    );
    if (!rec) return res.status(404).json({ error: 'Recording not found' });

    // One clip per recording — if it already exists, just return it.
    let clip = await db.queryOne(
      'SELECT * FROM voice_clips WHERE recording_id = $1',
      [recordingId]
    );

    const personName = (req.body.person_name != null && String(req.body.person_name).trim())
      ? String(req.body.person_name).trim()
      : firstName(rec.customer_name);
    const label = (req.body.label != null && String(req.body.label).trim())
      ? String(req.body.label).trim()
      : null;

    if (!clip) {
      const token = crypto.randomBytes(16).toString('base64url'); // ~22 chars, unguessable
      clip = await db.queryOne(
        `INSERT INTO voice_clips (customer_id, recording_id, public_token, person_name, label)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [rec.customer_id, recordingId, token, personName, label]
      );
    } else {
      // Let the admin refine the display text on an existing clip.
      clip = await db.queryOne(
        `UPDATE voice_clips SET person_name = $1, label = $2 WHERE id = $3 RETURNING *`,
        [personName, label, clip.id]
      );
    }

    res.json({ ok: true, clip, listenUrl: FRONTEND_BASE + '/listen.html?v=' + clip.public_token });
  } catch (err) {
    console.error('[admin/voice-clip create] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});

// GET /api/admin/voice-clip/:id/qr.png?session=...&size=1200
// Returns a high-resolution PNG QR code (error-correction H, good for print)
// pointing at the clip's public listen page. Drop it straight into the book.
router.get('/voice-clip/:id/qr.png', requireAdmin, async (req, res) => {
  try {
    const clip = await db.queryOne('SELECT public_token FROM voice_clips WHERE id = $1', [req.params.id]);
    if (!clip) return res.status(404).json({ error: 'Voice clip not found' });

    let size = parseInt(req.query.size, 10);
    if (!Number.isFinite(size) || size < 300) size = 1200;
    if (size > 2000) size = 2000;

    const url = FRONTEND_BASE + '/listen.html?v=' + clip.public_token;
    const png = await QRCode.toBuffer(url, {
      type: 'png',
      errorCorrectionLevel: 'H',
      margin: 2,
      width: size,
      color: { dark: '#5a1a1a', light: '#ffffff' }, // BCS maroon on white
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', (req.query.dl ? 'attachment' : 'inline') + '; filename="voice-qr.png"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(png);
  } catch (err) {
    console.error('[admin/voice-clip qr] error:', err);
    res.status(500).json({ error: 'Something went wrong generating the QR code.' });
  }
});

// DELETE /api/admin/voice-clip/:id  — revoke a clip (link stops working).
router.delete('/voice-clip/:id', requireAdmin, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM voice_clips WHERE id = $1', [req.params.id]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (err) {
    console.error('[admin/voice-clip delete] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});

// ===========================================================================
// PRINT ORDERS — visibility + a real Cancel button for the automatic Lulu
// hardcover orders. This turns the "24-hour safety window" into something Ken
// actually controls from his own dashboard: he can see every order and cancel
// one before Lulu sends it to print.
// ===========================================================================

// GET /api/admin/print-jobs — every print job, newest first.
router.get('/print-jobs', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT p.id, p.external_id, p.status, p.lulu_print_job_id, p.lulu_env,
             p.total_cost, p.currency, p.last_lulu_status, p.tracking_url,
             p.error, p.created_at, p.updated_at,
             c.id AS customer_id, c.name AS customer_name, c.email AS customer_email
        FROM print_jobs p
        LEFT JOIN customers c ON c.id = p.customer_id
       ORDER BY p.created_at DESC
    `);
    res.json({ ok: true, jobs: rows });
  } catch (err) {
    console.error('[admin/print-jobs] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});

// POST /api/admin/print-job/:id/refresh — pull the latest status from Lulu so
// Ken sees real state (UNPAID / IN_PRODUCTION / SHIPPED) and any tracking URL.
router.post('/print-job/:id/refresh', requireAdmin, async (req, res) => {
  try {
    const job = await db.queryOne(
      'SELECT id, lulu_print_job_id FROM print_jobs WHERE id = $1', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Print order not found' });
    if (!job.lulu_print_job_id) {
      return res.status(400).json({ error: 'This order was never placed with Lulu, so there is nothing to refresh.' });
    }
    const remote = await lulu.getPrintJob(job.lulu_print_job_id);
    const luluStatus = (remote && remote.status && (remote.status.name || remote.status)) || null;
    let tracking = null;
    try {
      const li = remote && remote.line_items && remote.line_items[0];
      tracking = (li && li.tracking_urls && li.tracking_urls[0])
        || (remote && remote.tracking_urls && remote.tracking_urls[0]) || null;
    } catch (_) { /* shape varies; tracking is best-effort */ }
    await db.query(
      `UPDATE print_jobs
         SET last_lulu_status = COALESCE($2, last_lulu_status),
             tracking_url = COALESCE($3, tracking_url),
             updated_at = NOW()
       WHERE id = $1`,
      [job.id, luluStatus, tracking]
    );
    res.json({ ok: true, last_lulu_status: luluStatus, tracking_url: tracking });
  } catch (err) {
    console.error('[admin/print-job/refresh] error:', err);
    res.status(502).json({ error: 'Could not reach Lulu to refresh this order: ' + err.message });
  }
});

// POST /api/admin/print-job/:id/cancel — cancel the order. Lulu only allows
// cancellation before the job enters production; if it is already printing,
// Lulu rejects it and we tell Ken plainly.
router.post('/print-job/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const job = await db.queryOne(
      'SELECT id, status, lulu_print_job_id FROM print_jobs WHERE id = $1', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Print order not found' });
    if (job.status === 'canceled') {
      return res.json({ ok: true, alreadyCanceled: true, message: 'This order was already canceled.' });
    }
    // No real Lulu order behind it (a test-mode 'validated' row, or an 'error'
    // row that never reached Lulu): just mark it canceled locally.
    if (!job.lulu_print_job_id) {
      await db.query(`UPDATE print_jobs SET status='canceled', updated_at=NOW() WHERE id=$1`, [job.id]);
      return res.json({ ok: true, message: 'Marked as canceled. (No live Lulu order was attached to this one — nothing was charged.)' });
    }
    // Ask Lulu to cancel. This fails if the job already entered production.
    let luluResult;
    try {
      luluResult = await lulu.cancelPrintJob(job.lulu_print_job_id);
    } catch (e) {
      return res.status(409).json({
        error: 'Lulu would not cancel this order — it may already be printing or shipped. Nothing was changed. (' + e.message + ')'
      });
    }
    const luluStatus = (luluResult && luluResult.status && (luluResult.status.name || luluResult.status)) || 'CANCELED';
    await db.query(
      `UPDATE print_jobs SET status='canceled', last_lulu_status=$2, updated_at=NOW() WHERE id=$1`,
      [job.id, luluStatus]
    );
    res.json({ ok: true, canceled: true, message: 'Order canceled at Lulu. It will not be printed or shipped.', last_lulu_status: luluStatus });
  } catch (err) {
    console.error('[admin/print-job/cancel] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});

module.exports = router;

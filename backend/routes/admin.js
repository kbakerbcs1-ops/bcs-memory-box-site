// Admin routes — Ken's dashboard for managing customers, recordings, drafts.
// Simple auth: password from env var ADMIN_PASSWORD, session token stored in
// the admin_sessions table.

const express = require('express');
const db = require('../lib/db');
const storage = require('../lib/storage');
const mailer = require('../lib/mailer');

const router = express.Router();
router.use(express.json());

const SESSION_TTL_DAYS = 7;

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
router.post('/login', async (req, res) => {
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

    res.json({ ok: true, customer, recordings, drafts, photos });
  } catch (err) {
    console.error('[admin/customer/:id] error:', err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/customer/:id
// Permanently removes a customer along with all of their recordings and drafts.
// The recordings/drafts rows are removed automatically by the database's
// ON DELETE CASCADE foreign keys; we additionally make a best-effort attempt
// to delete their stored files (audio + rendered .docx) from R2 so nothing is
// left orphaned. Intended for clearing out test accounts before launch.
// ---------------------------------------------------------------------------
router.delete('/customer/:id', requireAdmin, async (req, res) => {
  try {
    const customer = await db.queryOne(
      'SELECT id, email, name FROM customers WHERE id = $1',
      [req.params.id]
    );
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Collect storage keys BEFORE the rows are deleted so we can tidy up R2.
    const { rows: recs } = await db.query(
      'SELECT storage_key FROM recordings WHERE customer_id = $1',
      [req.params.id]
    );
    const { rows: drfts } = await db.query(
      'SELECT docx_storage_key FROM drafts WHERE customer_id = $1',
      [req.params.id]
    );
    const { rows: phts } = await db.query(
      'SELECT storage_key FROM photos WHERE customer_id = $1',
      [req.params.id]
    );
    const keys = recs.map(r => r.storage_key)
      .concat(drfts.map(d => d.docx_storage_key))
      .concat(phts.map(p => p.storage_key))
      .filter(Boolean);

    // Delete the customer; recordings + drafts go with it via ON DELETE CASCADE.
    await db.query('DELETE FROM customers WHERE id = $1', [req.params.id]);

    // Best-effort file cleanup — never fail the request just because R2 hiccups.
    let filesDeleted = 0;
    for (const key of keys) {
      try {
        await storage.deleteObject(key);
        filesDeleted++;
      } catch (e) {
        console.warn('[admin/customer/delete] could not delete ' + key + ': ' + e.message);
      }
    }

    console.log('[admin/customer/delete] removed ' + customer.email + ' (' + customer.id + '), ' + filesDeleted + ' file(s) cleaned up');
    res.json({ ok: true, deleted: true, email: customer.email, filesDeleted });
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
    if (!name) return res.status(400).json({ error: 'Please enter a name.' });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const existing = await db.queryOne(
      'SELECT id, access_token FROM customers WHERE email = $1', [email]);
    if (existing) {
      const url = 'https://www.bcsmemorybox.com/yourstory.html?token=' + encodeURIComponent(existing.access_token);
      return res.status(409).json({ error: 'A customer with that email already exists.', portalUrl: url });
    }

    const accessToken = db.randomToken(24);
    const created = await db.queryOne(
      `INSERT INTO customers (email, name, access_token, status, paid_at)
       VALUES ($1, $2, $3, 'recording', NOW())
       RETURNING id, access_token`,
      [email, name, accessToken]);

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
      message: emailed
        ? ('Added ' + name + ' as a free tester — welcome email sent to ' + email + '.')
        : ('Added ' + name + ', but the welcome email did not send. Share this link with them directly: ' + portalUrl),
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
      reply_to: 'kbakerbcs1@gmail.com',
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

module.exports = router;

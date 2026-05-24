// Admin routes — Ken's dashboard for managing customers, recordings, drafts.
// Simple auth: password from env var ADMIN_PASSWORD, session token stored in
// the admin_sessions table.

const express = require('express');
const db = require('../lib/db');
const storage = require('../lib/storage');

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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/customer/:id
// Full per-customer detail: customer record + all recordings + all drafts
// ---------------------------------------------------------------------------
router.get('/customer/:id', requireAdmin, async (req, res) => {
  try {
    const customer = await db.queryOne(
      `SELECT id, email, name, access_token, status, paid_at, created_at, updated_at,
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

    res.json({ ok: true, customer, recordings, drafts });
  } catch (err) {
    console.error('[admin/customer/:id] error:', err);
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

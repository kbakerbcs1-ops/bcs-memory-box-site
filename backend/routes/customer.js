// Customer-facing endpoints: signup, lookup own data via access_token.
// No password — the access_token in the URL IS the credential.

const express = require('express');
const db = require('../lib/db');

const router = express.Router();
router.use(express.json());

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

    // If a customer already exists for this email and hasn't paid yet, reuse the
    // existing access_token (so they can retry checkout instead of getting blocked).
    // If they've already paid, send them back to their existing portal URL.
    const existing = await db.queryOne(
      'SELECT id, access_token, status, paid_at FROM customers WHERE email = $1',
      [email]
    );

    if (existing) {
      if (existing.paid_at) {
        // Already a paying customer — just send them their portal URL again.
        return res.json({
          ok: true,
          alreadyExists: true,
          alreadyPaid: true,
          accessToken: existing.access_token,
          portalUrl: '/yourstory.html?token=' + encodeURIComponent(existing.access_token),
          message: 'Welcome back. You already have an account — heading you to your story.',
        });
      }
      // Has account but hasn't paid yet — resume checkout with the same token.
      return res.json({
        ok: true,
        alreadyExists: true,
        alreadyPaid: false,
        accessToken: existing.access_token,
        message: 'Welcome back — taking you to checkout.',
      });
    }

    const accessToken = db.randomToken(24);
    const result = await db.queryOne(
      `INSERT INTO customers (email, name, access_token, status)
       VALUES ($1, $2, $3, 'awaiting_payment')
       RETURNING id, access_token`,
      [email, name, accessToken]
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
// Returns the customer's own data (status, recordings, drafts).
// Used by the customer's personal portal page.
// ----------------------------------------------------------------------------
router.get('/me', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const customer = await db.queryOne(
      `SELECT id, email, name, status, paid_at, created_at
       FROM customers
       WHERE access_token = $1`,
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    const { rows: recordings } = await db.query(
      `SELECT id, original_filename, size_bytes, duration_seconds,
              transcript_status, created_at
       FROM recordings
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

    res.json({
      ok: true,
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        status: customer.status,
        paidAt: customer.paid_at,
        createdAt: customer.created_at,
      },
      recordings,
      drafts,
    });
  } catch (err) {
    console.error('[customer/me] error:', err);
    res.status(500).json({ error: 'Could not load your account data.' });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
      reply_to: 'kbakerbcs1@bcsmemorybox.com',
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

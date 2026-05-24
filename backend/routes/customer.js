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
          portalUrl: '/yourstory/' + existing.access_token,
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

module.exports = router;

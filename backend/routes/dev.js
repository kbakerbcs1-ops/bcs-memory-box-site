// ============================================================================
// DEV-ONLY routes. Remove before public launch.
//
// These exist so we can test the customer portal end-to-end without Stripe
// being wired up yet. Once Stripe checkout + webhook is live, the
// /mark-paid route here becomes redundant and should be deleted.
// ============================================================================

const express = require('express');
const db = require('../lib/db');

const router = express.Router();
router.use(express.json());

// POST /api/dev/mark-paid
// Body: { "token": "<access_token>" }
// Flips a customer from awaiting_payment to recording, sets paid_at = NOW.
// Idempotent.
router.post('/mark-paid', async (req, res) => {
  try {
    const token = req.body.token || req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const customer = await db.queryOne(
      'SELECT id, status FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    if (customer.status === 'awaiting_payment') {
      await db.query(
        `UPDATE customers
         SET status = 'recording', paid_at = NOW()
         WHERE id = $1`,
        [customer.id]
      );
    }

    res.json({
      ok: true,
      _warning: 'This is a dev-only endpoint and will be removed once Stripe is wired up.',
    });
  } catch (err) {
    console.error('[dev/mark-paid] error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

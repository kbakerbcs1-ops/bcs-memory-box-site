// POST /api/customer/finish-recording?token=<access_token>
// Fires the cleanup pipeline asynchronously. Returns immediately.

const express = require('express');
const db = require('../lib/db');
const { runCleanupPipeline } = require('../lib/cleanup');

const router = express.Router();
router.use(express.json());

router.post('/', async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const customer = await db.queryOne(
      'SELECT id, status FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    // Only allow finish from these statuses. If they're already processing/done,
    // tell them so but don't restart the pipeline.
    if (customer.status === 'awaiting_payment') {
      return res.status(403).json({ error: 'Payment is required before recording.' });
    }
    if (customer.status === 'processing') {
      return res.status(200).json({ ok: true, alreadyProcessing: true, message: 'Your memoir is already being prepared.' });
    }
    if (customer.status === 'draft_ready' || customer.status === 'delivered') {
      return res.status(200).json({ ok: true, alreadyDone: true, message: 'Your memoir draft is already done.' });
    }
    if (customer.status === 'error') {
      // Allow retry: we re-enter processing and try again
    }

    const { rows: recordings } = await db.query(
      'SELECT id FROM recordings WHERE customer_id = $1',
      [customer.id]
    );
    if (recordings.length === 0) {
      return res.status(400).json({ error: 'No recordings to process yet. Upload at least one recording first.' });
    }

    // Kick off the pipeline; do NOT await — we want to return immediately.
    runCleanupPipeline(customer.id).catch((err) => {
      console.error('[finish] pipeline crashed:', err);
    });

    res.json({
      ok: true,
      message: "Your memoir is being prepared. We'll email you when it's ready, usually within 30 minutes.",
    });
  } catch (err) {
    console.error('[finish] error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

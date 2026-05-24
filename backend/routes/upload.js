// Customer recording upload endpoint.
// POST /api/customer/upload?token=<access_token>
// multipart/form-data with field name "audio"

const express = require('express');
const multer = require('multer');
const db = require('../lib/db');
const storage = require('../lib/storage');

const router = express.Router();

// Multer config: keep file in memory, cap 100 MB per upload
// (matches roughly 1-2 hours of typical voice memo audio)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

router.post('/', upload.single('audio'), async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const customer = await db.queryOne(
      'SELECT id, status, paid_at FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    // Require the customer to be past awaiting_payment (i.e. paid).
    if (customer.status === 'awaiting_payment') {
      return res.status(403).json({
        error: 'Payment required before uploading recordings.',
      });
    }

    const audio = req.file;
    if (!audio) return res.status(400).json({ error: 'No audio file uploaded.' });

    // Derive a safe extension from the original filename, or fall back to mime type
    const ext = (audio.originalname || '').split('.').pop().toLowerCase() ||
                (audio.mimetype || '').split('/').pop() ||
                'bin';
    const safeExt = ext.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    const storageKey = `customers/${customer.id}/${Date.now()}-${db.randomToken(8)}.${safeExt}`;

    // Push the bytes to R2
    await storage.uploadObject(storageKey, audio.buffer, audio.mimetype);

    // Save the metadata
    const recording = await db.queryOne(
      `INSERT INTO recordings (customer_id, storage_key, original_filename, size_bytes)
       VALUES ($1, $2, $3, $4)
       RETURNING id, original_filename, size_bytes, transcript_status, created_at`,
      [customer.id, storageKey, audio.originalname || 'recording', audio.size]
    );

    res.json({ ok: true, recording });
  } catch (err) {
    console.error('[upload] error:', err);
    res.status(500).json({
      error: 'Upload failed. Please try again or email Ken if it keeps happening.',
      detail: err.message,
    });
  }
});

module.exports = router;

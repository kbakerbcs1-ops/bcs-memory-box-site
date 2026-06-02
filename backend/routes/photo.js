// Customer photo upload endpoint.
// POST /api/customer/upload-photo?token=<access_token>
// multipart/form-data with field name "photo" (+ optional text field "caption")
//
// Mirrors routes/upload.js (audio). Photos flow into R2 storage and a row in
// the photos table. Ken sees them in the admin dashboard and places them into
// the memoir when he polishes the draft.

const express = require('express');
const multer = require('multer');
const db = require('../lib/db');
const storage = require('../lib/storage');

const router = express.Router();

// Keep the file in memory, cap 25 MB per photo (comfortably covers a
// full-resolution phone photo, including HEIC).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.post('/', upload.single('photo'), async (req, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(401).json({ error: 'Missing access token' });

    const customer = await db.queryOne(
      'SELECT id, status FROM customers WHERE access_token = $1',
      [token]
    );
    if (!customer) return res.status(404).json({ error: 'Account not found' });

    // Require the customer to be past awaiting_payment (i.e. paid).
    if (customer.status === 'awaiting_payment') {
      return res.status(403).json({ error: 'Payment required before uploading photos.' });
    }

    const photo = req.file;
    if (!photo) return res.status(400).json({ error: 'No photo uploaded.' });

    // Derive a safe extension from the filename, or fall back to mime type.
    const ext = ((photo.originalname || '').split('.').pop() ||
                 (photo.mimetype || '').split('/').pop() ||
                 'jpg').toLowerCase();
    const safeExt = ext.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'jpg';
    const storageKey = `customers/${customer.id}/photos/${Date.now()}-${db.randomToken(8)}.${safeExt}`;

    // Push the bytes to R2
    await storage.uploadObject(storageKey, photo.buffer, photo.mimetype);

    // Optional caption (trim + cap length)
    const caption = (req.body.caption || '').trim().slice(0, 500) || null;

    const saved = await db.queryOne(
      `INSERT INTO photos (customer_id, storage_key, original_filename, size_bytes, content_type, caption)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, original_filename, size_bytes, caption, created_at`,
      [customer.id, storageKey, photo.originalname || 'photo', photo.size, photo.mimetype || null, caption]
    );

    res.json({ ok: true, photo: saved });
  } catch (err) {
    console.error('[photo upload] error:', err);
    res.status(500).json({
      error: 'Photo upload failed. Please try again or email Ken if it keeps happening.',
      detail: err.message,
    });
  }
});

module.exports = router;

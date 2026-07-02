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

// Detect HEIC/HEIF (iPhone) images by extension, mime, or the ftyp brand magic.
function isHeic(buffer, name, mime) {
  const n = (name || '').toLowerCase(), m = (mime || '').toLowerCase();
  if (n.endsWith('.heic') || n.endsWith('.heif')) return true;
  if (m.includes('heic') || m.includes('heif')) return true;
  if (buffer && buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12).toLowerCase();
    if (['heic','heix','hevc','heim','heis','hevm','hevs','mif1','msf1'].includes(brand)) return true;
  }
  return false;
}

// Physically apply a JPEG's EXIF orientation so portrait photos are stored upright.
async function autoOrient(buffer, contentType, filename) {
  const isJpeg = /jpe?g/i.test(contentType || '') || /\.jpe?g$/i.test(filename || '') ||
                 (buffer && buffer.length > 2 && buffer[0] === 0xFF && buffer[1] === 0xD8);
  if (!isJpeg) return buffer;
  try {
    const sharp = require('sharp');
    const meta = await sharp(buffer).metadata();
    if (meta.orientation && meta.orientation > 1) {
      return await sharp(buffer).rotate().jpeg({ quality: 90 }).toBuffer();
    }
  } catch (e) {
    console.error('[photo upload] auto-orient skipped: ' + e.message);
  }
  return buffer;
}

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

    // iPhone photos arrive as HEIC, which browsers (and Word documents) can't
    // display. Convert to JPEG on the way in so the photo shows everywhere and
    // embeds into the memoir.
    let photoBuffer = photo.buffer;
    let photoMime = photo.mimetype || '';
    let photoName = photo.originalname || 'photo';
    if (isHeic(photoBuffer, photoName, photoMime)) {
      try {
        const heicConvert = require('heic-convert');
        photoBuffer = Buffer.from(await heicConvert({ buffer: photoBuffer, format: 'JPEG', quality: 0.9 }));
        photoMime = 'image/jpeg';
        photoName = photoName.replace(/\.(heic|heif)$/i, '') + '.jpg';
      } catch (e) {
        console.error('[photo upload] HEIC conversion failed, storing original: ' + e.message);
      }
    }

    // Bake in EXIF orientation so portrait photos are stored (and shown) upright.
    photoBuffer = await autoOrient(photoBuffer, photoMime, photoName);

    // Derive a safe extension from the (possibly converted) filename or mime type.
    const ext = ((photoName || '').split('.').pop() ||
                 (photoMime || '').split('/').pop() ||
                 'jpg').toLowerCase();
    const safeExt = ext.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'jpg';
    const storageKey = `customers/${customer.id}/photos/${Date.now()}-${db.randomToken(8)}.${safeExt}`;

    // Push the bytes to R2
    await storage.uploadObject(storageKey, photoBuffer, photoMime);

    // Optional caption (trim + cap length)
    const caption = (req.body.caption || '').trim().slice(0, 500) || null;

    const saved = await db.queryOne(
      `INSERT INTO photos (customer_id, storage_key, original_filename, size_bytes, content_type, caption)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, original_filename, size_bytes, caption, created_at`,
      [customer.id, storageKey, photoName, photoBuffer.length, photoMime || null, caption]
    );

    res.json({ ok: true, photo: saved });
  } catch (err) {
    console.error('[photo upload] error:', err);
    res.status(500).json({
      error: 'Photo upload failed. Please try again or email Ken if it keeps happening.',
    });
  }
});

module.exports = router;

// ============================================================================
// routes/voice.js — "The Voice": PUBLIC listen endpoints for QR-in-the-book.
//
// These are intentionally unauthenticated: a family member scans the QR code
// printed in the hardcover, their phone opens listen.html?v=<public_token>,
// and that page calls these endpoints to show who it is and play the audio.
//
// Security model: the public_token is a long, random, unguessable string
// (created by the admin route). Nothing here exposes the customer's email,
// access token, other recordings, or any account data — only the one clip's
// display text and the one audio file it points to.
// ============================================================================
const express = require('express');
const db = require('../lib/db');
const storage = require('../lib/storage');

const router = express.Router();

// Look up a clip (+ its recording's storage key) by public token.
async function findClip(token) {
  if (!token) return null;
  return db.queryOne(
    `SELECT vc.id, vc.person_name, vc.label,
            r.storage_key, r.original_filename
       FROM voice_clips vc
       JOIN recordings r ON r.id = vc.recording_id
      WHERE vc.public_token = $1`,
    [token]
  );
}

// GET /api/voice/:token
// Returns just the display text the listen page needs. No audio here.
router.get('/:token', async (req, res) => {
  try {
    const clip = await findClip(req.params.token);
    if (!clip) return res.status(404).json({ error: 'This voice link was not found.' });
    res.json({
      ok: true,
      personName: clip.person_name || null,
      label: clip.label || null,
    });
  } catch (err) {
    console.error('[voice/:token] error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again in a moment.' });
  }
});

// GET /api/voice/:token/audio
// Streams the one recording this clip points to, straight from R2.
router.get('/:token/audio', async (req, res) => {
  try {
    const clip = await findClip(req.params.token);
    if (!clip) return res.status(404).json({ error: 'This voice link was not found.' });

    const { stream, contentType, contentLength } = await storage.getObjectStream(clip.storage_key);
    res.setHeader('Content-Type', contentType || 'audio/mpeg');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Disposition', 'inline');
    // Public keepsake link — safe to cache on the phone/CDN for a day.
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Accept-Ranges', 'none');
    stream.pipe(res);
  } catch (err) {
    console.error('[voice/:token/audio] error:', err);
    res.status(500).json({ error: 'Something went wrong playing this recording.' });
  }
});

module.exports = router;

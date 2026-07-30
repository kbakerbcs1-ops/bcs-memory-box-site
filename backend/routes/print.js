// Public print-asset endpoints. Lulu fetches a book's interior/cover PDF from
// here (unauthenticated, like the QR "listen" links) using the order's
// external_id, which embeds the customer + draft UUIDs (unguessable).
//
//   GET /api/print/book-<customerId>-<draftId>/interior.pdf
//   GET /api/print/book-<customerId>-<draftId>/cover.pdf

const express = require('express');
const db = require('../lib/db');
const storage = require('../lib/storage');

const router = express.Router();

const EXTERNAL_RE = /^book-([0-9a-f-]{36})-([0-9a-f-]{36})$/i;

router.get('/:externalId/:file', async (req, res) => {
  try {
    const m = EXTERNAL_RE.exec(req.params.externalId || '');
    if (!m) return res.status(404).send('Not found');
    const draftId = m[2];

    const draft = await db.queryOne(
      'SELECT interior_pdf_key, cover_pdf_key FROM drafts WHERE id = $1',
      [draftId]
    );
    if (!draft) return res.status(404).send('Not found');

    let key = null;
    if (req.params.file === 'interior.pdf') key = draft.interior_pdf_key;
    else if (req.params.file === 'cover.pdf') key = draft.cover_pdf_key;
    if (!key) return res.status(404).send('Not found');

    const obj = await storage.getObjectStream(key);
    res.setHeader('Content-Type', 'application/pdf');
    if (obj.contentLength) res.setHeader('Content-Length', obj.contentLength);
    res.setHeader('Cache-Control', 'no-store');
    obj.stream.pipe(res);
  } catch (err) {
    console.error('[print] error: ' + err.message);
    if (!res.headersSent) res.status(500).send('Error');
  }
});

module.exports = router;

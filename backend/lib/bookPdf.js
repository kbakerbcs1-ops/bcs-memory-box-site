// ============================================================================
// Print-ready interior PDF generator for Lulu.
//
// Renders a memoir (the same Markdown the .docx renderer uses) into an 8.5x11
// US-Letter, print-ready PDF with an embedded serif font (Lulu requires all
// fonts embedded), inline photos with captions, and a leftover "Photographs"
// section — matching the look Ken approved for his own book.
//
// Returns { buffer, pageCount }. pageCount is padded to Lulu's hardcover
// minimum and to an even number (books print in leaves of 2).
//
// Markdown grammar (produced by the memoir pipeline):
//   # Title            → the book title (its own title page)
//   ## Chapter          → chapter heading
//   [[PHOTO:N]]         → place photo N (1-based, matches the photos array order)
//   *italic line*       → an italic note line
//   anything else       → a body paragraph
// ============================================================================

const path = require('path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONTS = {
  regular: path.join(FONT_DIR, 'PTSerif-Regular.ttf'),
  bold: path.join(FONT_DIR, 'PTSerif-Bold.ttf'),
  italic: path.join(FONT_DIR, 'PTSerif-Italic.ttf'),
  boldItalic: path.join(FONT_DIR, 'PTSerif-BoldItalic.ttf'),
};

const BROWN = '#8B5A2B';
const DARK = '#2A2520';
const MARGIN = 72;              // 1 inch — comfortably inside Lulu's safety area
const MIN_PAGES = 24;           // Lulu hardcover case-wrap minimum

// Normalize a photo buffer to an upright JPEG and read its dimensions. Returns
// null if the image can't be decoded (so a bad photo never breaks the book).
async function normalizePhoto(p) {
  try {
    if (!p || !p.buffer) return null;
    const img = sharp(p.buffer, { failOn: 'none' }).rotate(); // bake EXIF orientation
    const meta = await img.metadata();
    const buffer = await img.jpeg({ quality: 88 }).toBuffer();
    return { buffer, width: meta.width || null, height: meta.height || null, caption: p.caption || '' };
  } catch (e) {
    return null;
  }
}

async function renderMemoirPdf(markdown, photos) {
  photos = photos || [];

  // Pre-decode every photo (async) before building the PDF (pdfkit layout is sync).
  const byIdx = {};
  for (let i = 0; i < photos.length; i++) {
    byIdx[i + 1] = await normalizePhoto(photos[i]);
  }

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    autoFirstPage: true,
    info: { Title: 'Memory Box memoir', Creator: 'BCS Memory Box' },
  });
  doc.registerFont('serif', FONTS.regular);
  doc.registerFont('serif-bold', FONTS.bold);
  doc.registerFont('serif-italic', FONTS.italic);
  doc.registerFont('serif-bolditalic', FONTS.boldItalic);

  const chunks = [];
  doc.on('data', (d) => chunks.push(d));
  const done = new Promise((resolve) => doc.on('end', resolve));

  const contentW = doc.page.width - MARGIN * 2;
  const placed = new Set();
  let titleDone = false;
  let pendingPageAfterTitle = false;

  function bodyDefaults() {
    doc.font('serif').fontSize(11.5).fillColor(DARK);
  }

  function placePhoto(n) {
    const ph = byIdx[n];
    if (!ph || placed.has(n)) return;
    placed.add(n);

    const maxW = Math.min(contentW, 300);   // ~4.1 in
    const maxH = 400;                        // ~5.5 in
    let w = ph.width || maxW;
    let h = ph.height || maxW;
    const scale = Math.min(maxW / w, maxH / h, 1);
    w = Math.round(w * scale);
    h = Math.round(h * scale);

    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + h + 26 > bottom) doc.addPage();

    const x = doc.page.margins.left + (contentW - w) / 2;
    const y = doc.y + 6;
    doc.image(ph.buffer, x, y, { width: w, height: h });
    doc.y = y + h + 4;
    doc.x = doc.page.margins.left;

    if (ph.caption) {
      doc.font('serif-italic').fontSize(9.5).fillColor(BROWN)
         .text(ph.caption, doc.page.margins.left, doc.y, { width: contentW, align: 'center' });
    }
    doc.moveDown(0.8);
    bodyDefaults();
  }

  const lines = String(markdown || '').split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    const photoMarker = line.match(/^\[\[PHOTO:(\d+)\]\]$/);
    if (photoMarker) { placePhoto(parseInt(photoMarker[1], 10)); continue; }
    if (!line) continue;

    if (pendingPageAfterTitle) { doc.addPage(); pendingPageAfterTitle = false; }

    if (line.startsWith('# ')) {
      // Title page: center the title vertically-ish, then start the story fresh.
      doc.moveDown(6);
      doc.font('serif-bold').fontSize(28).fillColor(BROWN)
         .text(line.slice(2), { align: 'center' });
      titleDone = true;
      pendingPageAfterTitle = true;
      bodyDefaults();
    } else if (line.startsWith('## ')) {
      doc.moveDown(1.1);
      doc.font('serif-bold').fontSize(17).fillColor(BROWN)
         .text(line.slice(3), { align: 'left' });
      doc.moveDown(0.4);
      bodyDefaults();
    } else {
      const isItalic = line.startsWith('*') && line.endsWith('*') && line.length > 2;
      const text = isItalic ? line.slice(1, -1) : line;
      doc.font(isItalic ? 'serif-italic' : 'serif').fontSize(11.5).fillColor(DARK)
         .text(text, { align: 'justify', lineGap: 2.5, paragraphGap: 6 });
    }
  }

  // Leftover photos → a Photographs section so no picture is ever lost.
  const leftover = [];
  for (let i = 0; i < photos.length; i++) { if (!placed.has(i + 1) && byIdx[i + 1]) leftover.push(i + 1); }
  if (leftover.length) {
    doc.addPage();
    doc.font('serif-bold').fontSize(17).fillColor(BROWN).text('Photographs', { align: 'left' });
    doc.moveDown(0.5);
    bodyDefaults();
    leftover.forEach(placePhoto);
  }

  // Pad to Lulu's minimum and to an even page count (blank trailing leaves).
  let count = doc.bufferedPageRange().count;
  while (count < MIN_PAGES || count % 2 !== 0) { doc.addPage(); count += 1; }

  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), pageCount: count };
}

module.exports = { renderMemoirPdf, normalizePhoto, MIN_PAGES };

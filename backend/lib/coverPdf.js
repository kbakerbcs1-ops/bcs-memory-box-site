// ============================================================================
// Print-ready wraparound COVER generator for Lulu (hardcover case wrap).
//
// Reproduces the approved BCS design (maroon wrap, cream tree-in-book emblem,
// front title, spine, back blurb) at Lulu's exact case-wrap dimensions.
//
// GEOMETRY (verified against Ken's real 2nd proof — 34 pages → 19.00 x 12.75 in):
//   trim              = 8.5 x 11 in
//   wrap + bleed      = 0.875 in on every outer side  (→ height is ALWAYS 12.75)
//   cover width       = 2*8.5 + spine + 2*0.875 = 18.75 + spine
//   spine (in)        = page_count / 136   (anchor: 34/136 = 0.25 in), min 0.0625
// The spine can be overridden with an exact value from Lulu's cover-dimensions
// API; the formula is the offline fallback.
//
// Returns { buffer, widthIn, heightIn, spineIn }.
// ============================================================================

const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const EMBLEM = path.join(__dirname, '..', 'assets', 'cover', 'emblem.png');
const EMBLEM_RATIO = 549 / 486; // height / width of the extracted emblem

const MAROON = '#730B22';
const CREAM = '#F4E8CE';

const TRIM_W = 8.5, TRIM_H = 11;
const WRAP = 0.875;                 // wrap + bleed per outer side
const COVER_H = TRIM_H + 2 * WRAP;  // 12.75 in, constant
const PPI_SPINE = 136;              // pages per inch of spine (from the real proof)

const IN = (v) => v * 72;          // inches → points

function spineForPages(pageCount) {
  return Math.max(0.0625, (pageCount || 24) / PPI_SPINE);
}

function renderCoverPdf(opts) {
  opts = opts || {};
  const name = opts.name || 'Your Name';
  const overline = opts.overline || 'The Life and Times of';
  const blurbLines = opts.blurbLines || [
    'The life story of ' + name + ',',
    'preserved in their own words',
    'through BCS Memory Box.',
  ];
  const url = opts.url || 'www.bcsmemorybox.com';
  const spineTitle = (opts.spineTitle || (overline + ' ' + name)).toUpperCase();

  const spineIn = opts.spineWidthIn ? Number(opts.spineWidthIn) : spineForPages(opts.pageCount);
  const coverWIn = 2 * TRIM_W + spineIn + 2 * WRAP;

  const W = IN(coverWIn), H = IN(COVER_H);

  // Panel x-edges (inches from left)
  const backLeft = WRAP;                    // 0.875
  const backCenter = backLeft + TRIM_W / 2; // 5.125
  const spineLeft = WRAP + TRIM_W;          // 9.375
  const spineCenterX = spineLeft + spineIn / 2;
  const frontLeft = spineLeft + spineIn;
  const frontCenter = frontLeft + TRIM_W / 2;

  const doc = new PDFDocument({ size: [W, H], margin: 0 });
  doc.registerFont('serif', path.join(FONT_DIR, 'PTSerif-Regular.ttf'));
  doc.registerFont('serif-bold', path.join(FONT_DIR, 'PTSerif-Bold.ttf'));
  doc.registerFont('serif-italic', path.join(FONT_DIR, 'PTSerif-Italic.ttf'));

  const chunks = [];
  doc.on('data', (d) => chunks.push(d));
  const done = new Promise((resolve) => doc.on('end', resolve));

  // Maroon background across the whole wrap.
  doc.rect(0, 0, W, H).fill(MAROON);

  // Helper: centered text block, x/width/y in inches, y = top of block.
  function centered(text, centerXIn, yIn, font, sizePt, widthIn) {
    const w = widthIn || 5;
    doc.font(font).fontSize(sizePt).fillColor(CREAM)
       .text(text, IN(centerXIn - w / 2), IN(yIn), { width: IN(w), align: 'center', lineBreak: true });
  }
  function rule(centerXIn, yIn, widthIn) {
    doc.moveTo(IN(centerXIn - widthIn / 2), IN(yIn)).lineTo(IN(centerXIn + widthIn / 2), IN(yIn))
       .lineWidth(0.75).strokeColor(CREAM).stroke();
  }
  function emblem(centerXIn, centerYIn, widthIn) {
    const wPt = IN(widthIn), hPt = wPt * EMBLEM_RATIO;
    doc.image(EMBLEM, IN(centerXIn) - wPt / 2, IN(centerYIn) - hPt / 2, { width: wPt, height: hPt });
  }

  // ---- FRONT panel (right) ----
  emblem(frontCenter, 4.2, 2.0);
  rule(frontCenter, 6.35, 2.3);
  centered(overline, frontCenter, 6.7, 'serif-italic', 17, 6.5);
  centered(name, frontCenter, 7.15, 'serif-bold', 32, 7.0);

  // ---- BACK panel (left) ----
  emblem(backCenter, 3.7, 1.7);
  centered(blurbLines.join('\n'), backCenter, 5.9, 'serif-italic', 15, 5.0);
  rule(backCenter, 7.5, 2.0);
  centered(url, backCenter, 9.9, 'serif', 12, 6.0);

  // ---- SPINE (only if wide enough to read) ----
  if (spineIn >= 0.25) {
    const spineFont = Math.min(11, Math.max(7, spineIn * 72 * 0.42));
    // Title reading up the spine, near the top; brand near the bottom.
    doc.save();
    doc.rotate(-90, { origin: [IN(spineCenterX), IN(3.2)] });
    doc.font('serif-bold').fontSize(spineFont).fillColor(CREAM)
       .text(spineTitle, IN(spineCenterX) - IN(3.0), IN(3.2) - spineFont / 2,
             { width: IN(6.0), align: 'center', lineBreak: false });
    doc.restore();

    doc.save();
    doc.rotate(-90, { origin: [IN(spineCenterX), IN(9.55)] });
    doc.font('serif-bold').fontSize(spineFont).fillColor(CREAM)
       .text('BCS MEMORY BOX', IN(spineCenterX) - IN(2.5), IN(9.55) - spineFont / 2,
             { width: IN(5.0), align: 'center', lineBreak: false });
    doc.restore();
  }

  doc.end();
  return done.then(() => ({
    buffer: Buffer.concat(chunks),
    widthIn: coverWIn,
    heightIn: COVER_H,
    spineIn,
  }));
}

module.exports = { renderCoverPdf, spineForPages, COVER_H, WRAP };

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
//   spine (in)        = STEPPED, from Lulu's own cover-dimensions API (below)
//
// The spine is NOT linear in page count. Measured from Lulu on 2026-08-22 for
// this package (0850X1100FCPRECW080CW444MXX): 24/50/66/80 pages -> 0.250 in;
// 90/100/110/120 -> 0.500; 150 -> 0.625; 200 -> 0.750; 300 -> 0.944; 500 -> 1.375.
// The previous formula (page_count / 136) assumed a straight line from zero and
// produced 0.486 in for a 66-page book, when Lulu required 0.250 in. That is
// what got Kelly Wright's first real order REJECTED on 2026-08-14.
//
// Callers that are about to ORDER must pass spineWidthIn from
// lulu.calculateCoverDimensions() — this table is only an offline fallback for
// preview covers, and the bands between measured points are approximate.
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
// Measured spine bands (pages -> spine inches), from Lulu's cover-dimensions API.
const SPINE_BANDS = [
  [80, 0.250], [120, 0.500], [150, 0.625], [200, 0.750], [300, 0.944], [500, 1.375],
];
const SPINE_SLOPE_ABOVE_500 = (1.375 - 0.944) / 200; // in per page, extrapolated

const IN = (v) => v * 72;          // inches → points

function spineForPages(pageCount) {
  const pages = Math.max(1, Number(pageCount) || 24);
  for (let i = 0; i < SPINE_BANDS.length; i++) {
    if (pages <= SPINE_BANDS[i][0]) return SPINE_BANDS[i][1];
  }
  return 1.375 + (pages - 500) * SPINE_SLOPE_ABOVE_500;
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

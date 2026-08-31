// ============================================================================
// lib/closed.js — BCS Memory Box is closed to customers.
//
// Closed August 31, 2026. To reopen the entire site, set CLOSED to false here
// and in the frontend's closed.js. Nothing else needs to change.
//
// While closed, these are refused:
//   - new signups, Stripe checkouts, and free-trial samples
//   - the customer portal: opening a story, recording, uploading photos
//   - the automatic re-engagement nudge emails (forced to dry-run)
//
// While closed, these DELIBERATELY KEEP RUNNING:
//   - /api/voice/*  the QR code printed inside Ken's hardcover still plays
//   - /api/admin/*  Ken's dashboard, to watch the last print jobs land
//   - /api/print/*  Lulu fetching print-ready PDFs for books already ordered
// ============================================================================

const CLOSED = true;

const CLOSED_MESSAGE =
  'BCS Memory Box is no longer taking new stories. Thank you for your interest.';

// Express middleware. Refuses the request while closed, passes through when open.
function closedGuard(req, res, next) {
  if (!CLOSED) return next();
  return res.status(503).json({ error: CLOSED_MESSAGE, closed: true });
}

module.exports = { CLOSED, CLOSED_MESSAGE, closedGuard };

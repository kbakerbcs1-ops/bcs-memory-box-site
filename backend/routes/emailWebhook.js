// ============================================================================
// routes/emailWebhook.js — Resend tells us when an email could not be delivered.
//
// WHY: on Aug 15 2026 a tester (Nancy) signed up with an address that did not
// exist. Every welcome and reminder bounced, nobody knew, and for two weeks she
// looked exactly like a customer ignoring us. She had never received a thing.
//
// What this does, for each event Resend sends to POST /api/email/webhook:
//   1. Verify the signature (Resend signs webhooks with Svix). Unsigned or
//      forged requests are refused.
//   2. Record the event once (Resend retries; the svix-id dedupes them).
//   3. If a customer's address is DEAD — a permanent bounce, a suppressed
//      address, a failed send, or a spam complaint — mark the customer
//      (customers.email_bounced_at), which stops reminder emails to them and
//      shows a red flag on the admin dashboard, and email Ken ONCE.
//   Temporary bounces (mailbox full, server busy) are recorded but not flagged.
//
// Setup (Ken, once, in the Resend dashboard): Webhooks -> Add endpoint ->
//   https://<backend>/api/email/webhook, events: email.bounced, email.failed,
//   email.suppressed, email.complained. Copy the signing secret (whsec_...) into
//   the server's RESEND_WEBHOOK_SECRET environment variable.
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const db = require('../lib/db');
const mailer = require('../lib/mailer');

const router = express.Router();

// Svix rejects anything older/newer than 5 minutes, to stop replayed requests.
const TOLERANCE_SECONDS = 5 * 60;

function verifySignature(rawBody, headers, secret) {
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signatures = headers['svix-signature'];
  if (!id || !timestamp || !signatures) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const signedContent = id + '.' + timestamp + '.' + rawBody.toString('utf8');
  const expected = Buffer.from(crypto.createHmac('sha256', key).update(signedContent).digest('base64'));

  // The header is a space-separated list like "v1,abc= v1,def=".
  return String(signatures).split(' ').some(function (entry) {
    const comma = entry.indexOf(',');
    if (comma === -1 || entry.slice(0, comma) !== 'v1') return false;
    const given = Buffer.from(entry.slice(comma + 1));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

// Which events mean "this address cannot be reached", and how to say so.
function deadAddressReason(event) {
  const data = event.data || {};
  const bounce = data.bounce || {};
  switch (event.type) {
    case 'email.bounced':
      // Only a Permanent bounce means the address is bad. Transient/Undetermined
      // (full mailbox, busy server) usually clear up on their own.
      if (bounce.type !== 'Permanent') return null;
      return 'Bounced: ' + (bounce.message || bounce.subType || 'the address does not accept mail');
    case 'email.suppressed':
      return 'Not sent: this address bounced or complained before, so Resend will not send to it';
    case 'email.failed':
      return 'Failed to send: ' + ((data.failed && data.failed.reason) || 'Resend could not deliver it');
    case 'email.complained':
      return 'Marked our email as spam';
    default:
      return null;
  }
}

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[email-webhook] RESEND_WEBHOOK_SECRET is not set — refusing unverified event');
    return res.status(500).json({ error: 'webhook not configured' });
  }
  if (!Buffer.isBuffer(req.body) || !verifySignature(req.body, req.headers, secret)) {
    console.warn('[email-webhook] rejected: bad or missing signature');
    return res.status(401).json({ error: 'invalid signature' });
  }

  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch (e) {
    return res.status(400).json({ error: 'invalid JSON' });
  }
  const data = event.data || {};
  const to = (Array.isArray(data.to) ? data.to : [data.to])
    .filter(Boolean).map(function (a) { return String(a).trim().toLowerCase(); });
  const reason = deadAddressReason(event);

  try {
    // Record it once. A retried delivery of the same event changes nothing.
    const inserted = await db.query(
      'INSERT INTO email_events (svix_id, event_type, resend_email_id, to_addresses, bounce_type, detail) ' +
      'VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (svix_id) DO NOTHING RETURNING id',
      [req.headers['svix-id'], String(event.type || ''), data.email_id || null, to,
       (data.bounce && data.bounce.type) || null, reason]
    );
    if (inserted.rows.length === 0 || !reason || to.length === 0) {
      return res.json({ ok: true });
    }

    // Record each dead address once. Only addresses that are NEW here get an
    // alert, so Ken hears once per dead address, not once per bounced message.
    // (Kept off the customers row on purpose — see migrations/016.)
    const { rows: newlyDead } = await db.query(
      'INSERT INTO email_dead_addresses (email, reason, event_type) ' +
      'SELECT UNNEST($1::text[]), $2, $3 ON CONFLICT (email) DO NOTHING RETURNING email',
      [to, reason, String(event.type)]
    );
    if (newlyDead.length === 0) return res.json({ ok: true });
    const { rows: flagged } = await db.query(
      'SELECT id, name, email FROM customers WHERE LOWER(email) = ANY($1::text[]) AND deleted_at IS NULL',
      [newlyDead.map(function (r) { return r.email; })]
    );

    for (const c of flagged) {
      console.warn('[email-webhook] dead address flagged: ' + c.email + ' — ' + reason);
      const html =
        '<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
        '<p>Ken,</p>' +
        '<p><strong>' + mailer.escapeHtml(c.name) + '</strong> is not getting our emails.</p>' +
        '<p>Address: <strong>' + mailer.escapeHtml(c.email) + '</strong><br>' +
        'What happened: ' + mailer.escapeHtml(reason) + '</p>' +
        '<p>The address is most likely mistyped. Nothing we send will reach them, so the ' +
        'automatic reminders to them have been stopped. They are marked in red on the dashboard.</p>' +
        '<p>Best next step: reach them another way (phone or text) and get the right address.</p>' +
        '<p>— Bullet</p></div>';
      try {
        await mailer.sendEmail(mailer.ADMIN_EMAIL, 'A customer is not getting our emails: ' + c.name, html);
      } catch (e) {
        console.error('[email-webhook] could not email Ken about ' + c.email + ': ' + e.message);
      }
    }
    return res.json({ ok: true, flagged: flagged.length });
  } catch (err) {
    // A 500 makes Resend retry later, so a database hiccup doesn't lose the event.
    console.error('[email-webhook] error:', err);
    return res.status(500).json({ error: 'could not record event' });
  }
});

module.exports = router;
module.exports.verifySignature = verifySignature; // exported for testing
module.exports.deadAddressReason = deadAddressReason;

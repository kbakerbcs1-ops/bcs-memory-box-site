// BCS Memory Box — customer re-engagement reminders (audit C5).
//
// THE PROBLEM this solves: before this, if a paying customer went quiet
// partway through — recorded a bit and closed the tab, answered their
// follow-up questions but never tapped "I'm done," or never opened the
// "your memoir is ready" email — NOTHING reached out to them. They just
// silently stalled (the live "Kelly" pattern). The only background job in
// the system watched one status and emailed only Ken.
//
// WHAT THIS DOES: once a day, look for customers who have been sitting in a
// stuck state past a gentle grace period and send them ONE warm, plain-spoken
// nudge with their own story link. Spaced out, capped at two nudges per stall,
// then it stops on its own. On a processing 'error' it also re-alerts Ken and
// sends the customer a reassuring note so no one is left in silence.
//
// SAFE BY DEFAULT: the scheduled caller passes dryRun = !REMINDERS_ENABLED, so
// until Ken flips REMINDERS_ENABLED=true in Render, this computes exactly who
// WOULD be nudged and sends nothing to customers. The admin "preview" button
// uses the same dry-run path so Ken can see the list before arming it.

const db = require('./db');
const mailer = require('./mailer');

// The statuses we re-engage, and how gently. graceDays = how long a customer
// must be quiet before the FIRST nudge; minGapDays = the minimum spacing before
// a follow-up nudge; maxNudges = the hard cap (then we stop, so no one is
// nagged). One status can drive more than one "kind" of message.
const PLAN = {
  awaiting_payment: [{ kind: 'awaiting_payment', audience: 'customer', graceDays: 2, minGapDays: 5, maxNudges: 2 }],
  recording:        [{ kind: 'recording',        audience: 'customer', graceDays: 3, minGapDays: 5, maxNudges: 2 }],
  follow_up:        [{ kind: 'follow_up',         audience: 'customer', graceDays: 3, minGapDays: 5, maxNudges: 2 }],
  draft_ready:      [{ kind: 'draft_ready',       audience: 'customer', graceDays: 3, minGapDays: 5, maxNudges: 2 }],
  delivered:        [{ kind: 'delivered',         audience: 'customer', graceDays: 4, minGapDays: 6, maxNudges: 2 }],
  error: [
    { kind: 'error_customer', audience: 'customer', graceDays: 1, minGapDays: 99, maxNudges: 1 },
    { kind: 'error_ken',      audience: 'ken',      graceDays: 1, minGapDays: 1,  maxNudges: 6 },
  ],
};

const ALL_STATUSES = Object.keys(PLAN);

// ---- Email bodies -------------------------------------------------------
// Branded to match the rest of the app's customer mail (Georgia serif, the
// warm brown button). Gentle, never pushy; no phone number anywhere (Ken's
// rule); help is always "just reply / hello@bcsmemorybox.com".

function reminderHtml({ name, intro, paras, buttonLabel, portalUrl, closing }) {
  const hello = 'Hi ' + mailer.escapeHtml((name || '').split(' ')[0] || 'there') + ',';
  const bodyParas = (paras || []).map(function (p) {
    return '<p style="margin:0 0 12px;">' + p + '</p>';
  }).join('');
  const button = portalUrl
    ? '<p style="margin:26px 0;text-align:center;">'
      + '<a href="' + portalUrl + '" style="background:#8b5a2b;color:#fff;padding:16px 34px;'
      + 'text-decoration:none;border-radius:6px;display:inline-block;font-family:Georgia,serif;'
      + 'font-weight:bold;font-size:18px;">' + mailer.escapeHtml(buttonLabel || 'Open my story') + '</a></p>'
      + '<p style="margin:0 0 4px;font-size:14px;color:#5a534c;">If the button does not work, copy and paste this link into your web browser:</p>'
      + '<p style="margin:0;font-size:14px;"><a href="' + portalUrl + '" style="color:#8b5a2b;word-break:break-all;">' + portalUrl + '</a></p>'
    : '';
  return '<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">'
    + '<h2 style="color:#8b5a2b;margin:0 0 14px;">' + mailer.escapeHtml(intro || 'Your Memory Box story') + '</h2>'
    + '<p style="margin:0 0 12px;">' + hello + '</p>'
    + bodyParas
    + button
    + '<p style="margin:22px 0 0;font-size:14px;color:#5a534c;">'
    + (closing || 'If you would like a hand, just reply to this email or write to hello@bcsmemorybox.com. '
      + 'And if you have already finished, please ignore this — all is well.')
    + '</p></div>';
}

// Build the {to, subject, html} for one due nudge. Returns null if we somehow
// can't (e.g. a customer nudge with no email).
function buildMessage(rule, c) {
  const portalUrl = c.access_token ? mailer.portalUrlFor(c.access_token) : null;

  if (rule.kind === 'awaiting_payment') {
    return { to: c.email, subject: 'Your Memory Box is ready when you are', html: reminderHtml({
      name: c.name, intro: 'Pick up where you left off', buttonLabel: 'Finish setting up my story', portalUrl,
      paras: [
        'You started creating your Memory Box story — I am so glad you did.',
        'Your spot is saved. Whenever you are ready, tap the button below to finish and begin recording. There is no rush at all.',
      ] }) };
  }
  if (rule.kind === 'recording') {
    return { to: c.email, subject: 'Your story is waiting whenever you are ready', html: reminderHtml({
      name: c.name, intro: 'Your story is waiting', buttonLabel: 'Add to my story', portalUrl,
      paras: [
        'You have made a start on your Memory Box — that is wonderful.',
        'Whenever you have a few minutes, you can add a little more, one memory at a time. Tap below to pick up right where you left off. You do not have to do it all at once.',
      ] }) };
  }
  if (rule.kind === 'follow_up') {
    return { to: c.email, subject: 'You are one tap away from your finished book', html: reminderHtml({
      name: c.name, intro: 'Just one last step', buttonLabel: 'Open my story', portalUrl,
      paras: [
        'You have answered your follow-up questions — thank you! Your book is almost ready.',
        'There is just one last step: open your story and tap the big green button that says '
          + '<strong>&ldquo;I&rsquo;m done &mdash; finish my book.&rdquo;</strong> '
          + 'That tells us to write everything up for you. That is all that is left.',
      ] }) };
  }
  if (rule.kind === 'draft_ready') {
    return { to: c.email, subject: 'Your draft is ready to read', html: reminderHtml({
      name: c.name, intro: 'Your draft is ready', buttonLabel: 'Read my draft', portalUrl,
      paras: [
        'Your Memory Box draft is written and waiting for you to read.',
        'Have a look whenever you like. If anything needs changing, you can just say so out loud — no typing — and we will fix it for you.',
      ] }) };
  }
  if (rule.kind === 'delivered') {
    return { to: c.email, subject: 'Your memoir is ready to see', html: reminderHtml({
      name: c.name, intro: 'Your memoir is ready', buttonLabel: 'Open my memoir', portalUrl,
      paras: [
        'Your finished memoir is ready — here is your link again, in case the first note got buried in your inbox.',
        'Read it over whenever you like. When it looks just right to you, you can approve it and we will print your hardcover book and mail it to you.',
      ] }) };
  }
  if (rule.kind === 'error_customer') {
    return { to: c.email, subject: 'We are putting the finishing touches on your book', html: reminderHtml({
      name: c.name, intro: 'We are on it', buttonLabel: 'Open my story', portalUrl,
      paras: [
        'I wanted to let you know we are personally looking over your story to make sure it comes out just right.',
        'You do not need to do anything — we will be in touch soon. Thank you for your patience.',
      ] }) };
  }
  if (rule.kind === 'error_ken') {
    const portalNote = portalUrl ? ('<p style="margin:0 0 8px;">Their story page: <a href="' + portalUrl + '">' + portalUrl + '</a></p>') : '';
    return { to: mailer.ADMIN_EMAIL, subject: '⚠️ A customer’s book is stuck in error — needs a look', html:
      '<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">'
      + '<h2 style="color:#c0392b;margin:0 0 12px;">A book is stuck in error</h2>'
      + '<p style="margin:0 0 8px;"><strong>' + mailer.escapeHtml(c.name || '(no name)') + '</strong> &lt;' + mailer.escapeHtml(c.email || '') + '&gt;</p>'
      + '<p style="margin:0 0 8px;">Has been in <strong>error</strong> for about ' + Math.round(c.ageDays) + ' day(s).</p>'
      + portalNote
      + '<p style="margin:12px 0 0;">You can hit <strong>Reprocess</strong> on their card in the dashboard, or check the logs. The customer has been sent a gentle "we’re on it" note so they are not left wondering.</p>'
      + '</div>' };
  }
  return null;
}

// ---- The sweep ----------------------------------------------------------

// Runs one pass. opts.dryRun = true computes the due list but sends nothing.
// Returns a structured report (used by the scheduler AND the admin preview).
async function runReminderSweep(opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  const report = { dryRun: dryRun, due: [], sent: 0, errors: [] };

  if (!db.enabled) { report.errors.push('database not configured'); return report; }

  // Everyone currently in a re-engageable state, with a "last activity" clock.
  // last_activity = the later of the customer row's updated_at (status changes)
  // and their most recent recording upload, so someone actively recording is
  // not counted as stalled.
  const rows = (await db.query(
    "SELECT c.id, c.name, c.email, c.access_token, c.status, " +
    "  GREATEST(c.updated_at, COALESCE(r.last_rec, c.created_at)) AS last_activity, " +
    "  EXTRACT(EPOCH FROM (NOW() - GREATEST(c.updated_at, COALESCE(r.last_rec, c.created_at)))) / 86400.0 AS age_days " +
    "FROM customers c " +
    "LEFT JOIN (SELECT customer_id, MAX(created_at) AS last_rec FROM recordings GROUP BY customer_id) r " +
    "  ON r.customer_id = c.id " +
    "WHERE c.deleted_at IS NULL AND c.email IS NOT NULL AND c.status = ANY($1::text[])",
    [ALL_STATUSES]
  )).rows;

  // Reminder history for these customers, grouped by (customer, kind).
  const hist = {}; // key `${customer_id}|${kind}` -> { cnt, daysSince }
  if (rows.length) {
    const ids = rows.map(function (r) { return r.id; });
    const h = (await db.query(
      "SELECT customer_id, kind, COUNT(*)::int AS cnt, " +
      "  EXTRACT(EPOCH FROM (NOW() - MAX(sent_at))) / 86400.0 AS days_since " +
      "FROM customer_reminders WHERE customer_id = ANY($1::uuid[]) GROUP BY customer_id, kind",
      [ids]
    )).rows;
    h.forEach(function (x) { hist[x.customer_id + '|' + x.kind] = { cnt: x.cnt, daysSince: Number(x.days_since) }; });
  }

  // Decide who is due.
  const due = [];
  rows.forEach(function (c) {
    const ageDays = Number(c.age_days);
    const rules = PLAN[c.status] || [];
    rules.forEach(function (rule) {
      const prior = hist[c.id + '|' + rule.kind] || { cnt: 0, daysSince: Infinity };
      const dueNow = ageDays >= rule.graceDays
        && prior.cnt < rule.maxNudges
        && prior.daysSince >= rule.minGapDays;
      if (dueNow) {
        due.push({ rule: rule, customer: Object.assign({}, c, { ageDays: ageDays }), nudgeNumber: prior.cnt + 1 });
      }
    });
  });

  // Report the due list (safe to expose — no tokens).
  report.due = due.map(function (d) {
    return {
      name: d.customer.name, email: d.customer.email, status: d.customer.status,
      kind: d.rule.kind, audience: d.rule.audience,
      ageDays: Math.round(d.customer.ageDays * 10) / 10, nudgeNumber: d.nudgeNumber,
    };
  });

  if (dryRun) {
    await logSweep(true, 0, report.due).catch(function () {});
    return report;
  }

  // Send for real. Each send is independent — one failure never aborts the batch.
  for (let i = 0; i < due.length; i++) {
    const d = due[i];
    try {
      const msg = buildMessage(d.rule, d.customer);
      if (!msg || !msg.to) throw new Error('no recipient for kind ' + d.rule.kind);
      await mailer.sendEmail(msg.to, msg.subject, msg.html);
      await db.query('INSERT INTO customer_reminders (customer_id, kind) VALUES ($1, $2)', [d.customer.id, d.rule.kind]);
      report.sent++;
    } catch (e) {
      report.errors.push((d.customer.email || '?') + '/' + d.rule.kind + ': ' + e.message);
    }
  }

  await logSweep(false, report.sent, report.due).catch(function () {});
  return report;
}

async function logSweep(dryRun, sentCount, dueList) {
  const detail = JSON.stringify((dueList || []).map(function (d) { return d.kind + ':' + (d.email || ''); }));
  await db.query(
    'INSERT INTO reminder_sweeps (dry_run, sent_count, detail) VALUES ($1, $2, $3)',
    [dryRun, sentCount, detail.slice(0, 4000)]
  );
}

// Boot catch-up guard: has a REAL (non-dry-run) sweep run in the last ~20h?
// Lets us fire on boot after a restart without double-sweeping the same day.
async function lastRealSweepAgeHours() {
  if (!db.enabled) return null;
  const r = (await db.query(
    "SELECT EXTRACT(EPOCH FROM (NOW() - MAX(ran_at))) / 3600.0 AS hrs FROM reminder_sweeps WHERE dry_run = FALSE"
  )).rows[0];
  return r && r.hrs != null ? Number(r.hrs) : null;
}

module.exports = { runReminderSweep, lastRealSweepAgeHours, PLAN };

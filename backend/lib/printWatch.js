// ============================================================================
// Print-job watchdog.
//
// WHY THIS EXISTS: on 2026-08-14 Kelly Wright's hardcover was submitted to Lulu
// and REJECTED six seconds later (cover 19.236in when Lulu required 19.00in).
// Nothing in the system ever asked Lulu what happened, so our dashboard showed
// 'CREATED' for nine days while she waited for a book that was never printed.
// A submitted job must never again be assumed to be a printing job.
//
// This sweep re-asks Lulu about every job that has not reached a terminal state,
// records the answer, and emails Ken ONCE when a job has failed.
// ============================================================================

const db = require('./db');
const lulu = require('./lulu');
const mailer = require('./mailer');

// Lulu statuses that mean "nothing more will change on its own".
const TERMINAL_OK = ['SHIPPED'];
const TERMINAL_BAD = ['REJECTED', 'CANCELED'];

// Pull Lulu's human-readable rejection text out of the nested line-item shape.
function reasonFromJob(remote) {
  const out = [];
  const items = (remote && remote.line_items) || [];
  for (const li of items) {
    const msgs = (li && li.status && li.status.messages) || null;
    if (!msgs) continue;
    if (typeof msgs === 'string') { out.push(msgs); continue; }
    for (const group of Object.values(msgs)) {
      if (typeof group === 'string') { out.push(group); continue; }
      for (const val of Object.values(group || {})) {
        if (Array.isArray(val)) out.push(...val.map(String));
        else if (val) out.push(String(val));
      }
    }
  }
  const top = remote && remote.status && remote.status.message;
  if (!out.length && top) out.push(String(top));
  return out.join(' | ').slice(0, 1500) || 'no reason given by Lulu';
}

async function sweepPrintJobs() {
  if (!lulu.enabled) return { checked: 0, failed: 0, skipped: 'lulu not configured' };

  const { rows } = await db.query(
    `SELECT p.id, p.status, p.lulu_print_job_id, p.last_lulu_status,
            c.name AS customer_name, c.email AS customer_email
       FROM print_jobs p
       LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.lulu_print_job_id IS NOT NULL
        AND (p.last_lulu_status IS NULL OR p.last_lulu_status NOT IN ('SHIPPED','REJECTED','CANCELED'))`
  );
  const jobs = rows || [];
  let failed = 0;

  for (const job of jobs) {
    let remote;
    try {
      remote = await lulu.getPrintJob(job.lulu_print_job_id);
    } catch (e) {
      console.error('[printwatch] could not read Lulu job ' + job.lulu_print_job_id + ': ' + e.message);
      continue;
    }
    const status = (remote && remote.status && (remote.status.name || remote.status)) || null;
    let tracking = null;
    try {
      const li = remote && remote.line_items && remote.line_items[0];
      tracking = (li && li.tracking_urls && li.tracking_urls[0])
        || (remote && remote.tracking_urls && remote.tracking_urls[0]) || null;
    } catch (_) { /* shape varies */ }

    const isBad = status && TERMINAL_BAD.includes(String(status).toUpperCase());
    const alreadyFlagged = job.status === 'error';

    await db.query(
      `UPDATE print_jobs
          SET last_lulu_status = COALESCE($2, last_lulu_status),
              tracking_url     = COALESCE($3, tracking_url),
              status           = CASE WHEN $4 THEN 'error' ELSE status END,
              error            = CASE WHEN $4 THEN $5 ELSE error END,
              updated_at       = NOW()
        WHERE id = $1`,
      [job.id, status, tracking, !!isBad, isBad ? reasonFromJob(remote) : null]
    );

    if (isBad && !alreadyFlagged) {
      failed++;
      const who = job.customer_name || job.customer_email || 'A customer';
      const reason = reasonFromJob(remote);
      console.error('[printwatch] Lulu job ' + job.lulu_print_job_id + ' is ' + status + ': ' + reason);
      try {
        await mailer.sendEmail(mailer.ADMIN_EMAIL,
          'The printer rejected a book — ' + who + ' is waiting',
          '<div style="font-family:Georgia,serif;max-width:620px;line-height:1.6;color:#2a2520;">' +
          '<h2 style="color:#8B1A2B;">Lulu did not print this book</h2>' +
          '<p><strong>' + mailer.escapeHtml(who) + '</strong> approved their book, but Lulu marked the order <strong>' +
          mailer.escapeHtml(String(status)) + '</strong>. It is NOT being printed and it will NOT ship.</p>' +
          '<p style="font-size:14px;color:#5a534c;"><strong>Lulu says:</strong><br>' +
          mailer.escapeHtml(reason) + '</p>' +
          '<p>Lulu print job: ' + mailer.escapeHtml(String(job.lulu_print_job_id)) + '</p>' +
          '<p>Fix the cause, then use <strong>Retry print</strong> on their customer page. ' +
          'They have been waiting since the day they approved, so it is worth telling them where things stand.</p>' +
          '</div>');
      } catch (mailErr) {
        console.error('[printwatch] could not email Ken about rejected job: ' + mailErr.message);
      }
    }
  }
  return { checked: jobs.length, failed };
}

module.exports = { sweepPrintJobs, reasonFromJob };

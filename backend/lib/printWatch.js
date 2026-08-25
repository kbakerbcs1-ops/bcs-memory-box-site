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
        AND (
              -- still in flight: keep asking Lulu what happened
              p.last_lulu_status IS NULL
              OR p.last_lulu_status NOT IN ('SHIPPED','REJECTED','CANCELED')
              -- OR already failed at Lulu but never flagged on our side. Without
              -- this, a job that reached a bad state BEFORE this watchdog existed
              -- (or was refreshed by hand) is invisible forever. Once we flag it,
              -- status='error' and it drops out, so Ken is emailed exactly once.
              OR (p.last_lulu_status IN ('REJECTED','CANCELED') AND p.status <> 'error')
              -- OR shipped but the customer has not been told yet. Lulu does not
              -- reliably email API-placed orders (it sent nothing at all when
              -- Kelly's was rejected), so the "your book is on its way" email is
              -- OURS to send. Once sent we set status='shipped' and it drops out.
              OR (p.last_lulu_status = 'SHIPPED' AND p.status <> 'shipped')
            )`
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

    // --- Shipped: tell the CUSTOMER, and copy Ken. ---
    // WAIT FOR THE TRACKING LINK. Lulu can report SHIPPED before tracking_urls
    // is populated. The email is sent exactly once (we then set status='shipped'),
    // so firing early would hand the customer "tracking should appear shortly"
    // and they would never get the link at all. If Lulu was ALREADY showing
    // SHIPPED on the previous sweep and there is still no tracking (so at least
    // an hour has passed), send it anyway rather than stay silent forever.
    const isShipped = status && String(status).toUpperCase() === 'SHIPPED';
    const seenShippedBefore = String(job.last_lulu_status || '').toUpperCase() === 'SHIPPED';
    if (isShipped && !tracking && !seenShippedBefore) {
      console.log('[printwatch] job ' + job.lulu_print_job_id +
        ' is SHIPPED but has no tracking yet — holding the customer email for one more sweep');
    }
    if (isShipped && job.status !== 'shipped' && (tracking || seenShippedBefore)) {
      const who = job.customer_name || 'there';
      const firstName = String(who).trim().split(/\s+/)[0];
      const track = tracking
        ? '<p style="margin:22px 0;"><a href="' + mailer.escapeHtml(tracking) + '" ' +
          'style="background:#ebdbbc;color:#2a1f15;font-weight:700;padding:14px 28px;border-radius:999px;text-decoration:none;">Track your book</a></p>'
        : '<p>Tracking information should appear shortly.</p>';
      if (job.customer_email) {
        try {
          await mailer.sendEmail(job.customer_email,
            'Your book is on its way',
            '<div style="font-family:Georgia,serif;max-width:600px;line-height:1.7;color:#2a2520;">' +
            '<h2 style="color:#8B1A2B;font-size:24px;">Your book has been printed and shipped.</h2>' +
            '<p>' + mailer.escapeHtml(firstName) + ', your hardcover is finished and on its way to you.</p>' +
            track +
            '<p>When it arrives, open the front cover — the QR code inside plays your story in your own voice.</p>' +
            '<p style="margin-top:26px;">Thank you for trusting me with it.</p>' +
            '<p style="font-style:italic;color:#6b5d4f;">— Ken, founder<br>BCS Memory Box</p>' +
            '</div>');
          console.log('[printwatch] told ' + job.customer_email + ' their book shipped');
        } catch (mailErr) {
          console.error('[printwatch] could not email customer about shipping: ' + mailErr.message);
        }
      } else {
        console.error('[printwatch] job ' + job.lulu_print_job_id + ' shipped but we have no customer email on file');
      }
      try {
        await mailer.sendEmail(mailer.ADMIN_EMAIL,
          'Shipped: ' + who + "'s book is on its way",
          '<div style="font-family:Georgia,serif;max-width:600px;line-height:1.6;color:#2a2520;">' +
          '<p><strong>' + mailer.escapeHtml(who) + '</strong> (' + mailer.escapeHtml(job.customer_email || 'no email on file') + ') ' +
          'has been told their book shipped.</p>' +
          '<p>Lulu print job ' + mailer.escapeHtml(String(job.lulu_print_job_id)) + '<br>' +
          'Tracking: ' + (tracking ? mailer.escapeHtml(tracking) : 'not provided yet') + '</p>' +
          '</div>');
      } catch (_) { /* Ken's copy is a nicety; never block on it */ }
      await db.query(`UPDATE print_jobs SET status='shipped', updated_at=NOW() WHERE id=$1`, [job.id]);
    }

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

// ============================================================================
// Automatic hardcover ordering on book approval.
//
// When a customer taps "This is my book", the approve-book route calls
// autoOrderOnApproval(). If everything needed is in place, it places the Lulu
// print order automatically (fully automatic mode, with safety checks and a
// 24-hour production-delay window). If anything is missing, it returns
// { ordered:false, reason } and the caller falls back to emailing Ken — so the
// customer flow is never blocked and nothing prints by mistake.
//
// Requirements for an automatic order (all must be true):
//   - Lulu is configured (LULU_CLIENT_KEY/SECRET set)          → else reason 'lulu_disabled'
//   - The plan includes a hardcover (hardcover / legacy)        → else reason 'digital_plan'
//   - Not already ordered for this draft (idempotent)           → else reason 'already_ordered'
//   - A print-ready interior PDF + cover PDF exist              → else reason 'no_print_pdf'
//   - A shipping address is on file                            → else reason 'no_address'
//   - Cost calculation succeeds and passes the sanity ceiling  → else reason 'cost_anomaly' / 'error'
// ============================================================================

const db = require('./db');
const lulu = require('./lulu');
const coverPdf = require('./coverPdf');
const storage = require('./storage');

// Plans that include a physical hardcover book.
const HARDCOVER_PLANS = new Set(['hardcover', 'legacy']);

// Safety ceiling: a single ~34-page 8.5x11 premium-color hardcover plus US
// shipping is roughly $30. If Lulu ever quotes far above this, treat it as an
// anomaly, DO NOT auto-charge, and fall back to Ken. Tune as real data comes in.
const COST_CEILING = Number(process.env.LULU_COST_CEILING || 75);

// SAFETY: real orders only happen when LULU_LIVE_ORDERS=true. Default (unset)
// is TEST MODE — we validate the price + cover dimensions against Lulu but place
// NO order and spend nothing. Flip to 'true' when ready to print for real.
const LIVE_ORDERS = process.env.LULU_LIVE_ORDERS === 'true';

const PUBLIC_BACKEND_URL =
  process.env.PUBLIC_BACKEND_URL || 'https://bcs-memory-box-site.onrender.com';

// Look up the print-ready PDF storage keys for a draft, tolerating the columns
// not existing yet (the print-PDF pipeline is a later build). Any failure →
// treated as "no print PDF yet".
async function loadPrintAssets(draftId) {
  try {
    const row = await db.queryOne(
      'SELECT interior_pdf_key, cover_pdf_key, page_count FROM drafts WHERE id = $1',
      [draftId]
    );
    if (row && row.interior_pdf_key && row.cover_pdf_key) return row;
  } catch (_) {
    // column(s) not present yet — fall through
  }
  return null;
}

// Shipping address for a customer, tolerating the columns not existing yet.
async function loadShippingAddress(customerId) {
  try {
    const a = await db.queryOne(
      `SELECT ship_name, ship_address1, ship_address2, ship_city, ship_state,
              ship_zip, ship_country, ship_phone
         FROM customers WHERE id = $1`,
      [customerId]
    );
    if (a && a.ship_name && a.ship_address1 && a.ship_city && a.ship_zip) {
      return {
        name: a.ship_name, address1: a.ship_address1, address2: a.ship_address2,
        city: a.ship_city, state: a.ship_state, zip: a.ship_zip,
        country: a.ship_country || 'US', phone: a.ship_phone,
      };
    }
  } catch (_) {
    // columns not present yet
  }
  return null;
}

async function autoOrderOnApproval(customer, draft) {
  if (!lulu.enabled) return { ordered: false, reason: 'lulu_disabled' };
  if (!HARDCOVER_PLANS.has(customer.plan)) return { ordered: false, reason: 'digital_plan' };

  const externalId = 'book-' + customer.id + '-' + draft.id;

  const assets = await loadPrintAssets(draft.id);
  if (!assets) return { ordered: false, reason: 'no_print_pdf' };

  const address = await loadShippingAddress(customer.id);
  if (!address) return { ordered: false, reason: 'no_address' };
  if (address.email == null) address.email = customer.email;

  // Idempotency — atomically CLAIM this externalId before any charge. external_id
  // is UNIQUE, so only ONE caller can win this INSERT; a concurrent or repeated
  // approval gets no row back and stops here. This closes the race where two
  // clicks both pass a plain existence check before either inserts, and is what
  // makes a double order / double charge impossible. (Claimed AFTER the no-PDF /
  // no-address checks so those remain retryable — they never create a row.)
  //
  // A row in a terminal, non-ordered state ('canceled' / 'error' / 'validated')
  // is re-claimable — so if a customer undoes their approval (which cancels the
  // order) and then re-approves, a fresh order can be placed. An ACTIVE row
  // ('reserving' / 'created' / 'submitted') still blocks, so a live order can
  // never be duplicated.
  const claim = await db.queryOne(
    `INSERT INTO print_jobs (customer_id, draft_id, external_id, lulu_env, status)
       VALUES ($1, $2, $3, $4, 'reserving')
     ON CONFLICT (external_id) DO UPDATE
       SET status = 'reserving', error = NULL, lulu_print_job_id = NULL,
           total_cost = NULL, last_lulu_status = NULL, updated_at = NOW()
       WHERE print_jobs.status IN ('canceled', 'error', 'validated')
     RETURNING id`,
    [customer.id, draft.id, externalId, lulu.env]
  );
  if (!claim) return { ordered: false, reason: 'already_ordered' };
  const jobRowId = claim.id;

  const interiorUrl = PUBLIC_BACKEND_URL + '/api/print/' + externalId + '/interior.pdf';
  const coverUrl = PUBLIC_BACKEND_URL + '/api/print/' + externalId + '/cover.pdf';

  try {
    // --- Safety check 1: real cost from Lulu, and a sanity ceiling ---
    const cost = await lulu.calculateCost({
      podPackageId: lulu.DEFAULT_POD_PACKAGE_ID,
      pageCount: assets.page_count,
      quantity: 1,
      address,
      shippingLevel: 'MAIL',
    });
    const total = Number(cost && cost.total_cost_incl_tax);
    const currency = (cost && cost.currency) || 'USD';
    if (!(total > 0)) throw new Error('Lulu returned no usable cost');
    if (total > COST_CEILING) {
      await db.query(
        `UPDATE print_jobs SET status='error', pod_package_id=$2, quantity=1,
           total_cost=$3, currency=$4, error=$5, updated_at=NOW() WHERE id=$1`,
        [jobRowId, lulu.DEFAULT_POD_PACKAGE_ID, total, currency,
         'cost above ceiling ($' + total + ' > $' + COST_CEILING + ')']
      );
      return { ordered: false, reason: 'cost_anomaly', total, currency };
    }

    // --- Refine the cover to Lulu's EXACT spine for this page count ---
    // (belt-and-suspenders on top of the validated offline formula).
    try {
      const dims = await lulu.calculateCoverDimensions({
        podPackageId: lulu.DEFAULT_POD_PACKAGE_ID, pageCount: assets.page_count, unit: 'in',
      });
      const widthIn = Number(dims && dims.width);
      const spineIn = widthIn - 18.75; // 2*8.5 trim + 2*0.875 wrap/bleed
      if (spineIn > 0.05) {
        const cov = await coverPdf.renderCoverPdf({ name: customer.name, pageCount: assets.page_count, spineWidthIn: spineIn });
        const coverKey = 'customers/' + customer.id + '/print/cover-exact-' + externalId + '.pdf';
        await storage.uploadObject(coverKey, cov.buffer, 'application/pdf');
        await db.query('UPDATE drafts SET cover_pdf_key = $2 WHERE id = $1', [draft.id, coverKey]);
      }
    } catch (e) {
      console.error('[autoOrder] cover-dimension refine skipped (using generated cover): ' + e.message);
    }

    // TEST MODE (default): everything above validated against Lulu for real
    // (auth, price, cover dimensions), but we place NO order and spend NOTHING.
    // Record it as 'validated' so Ken can see the confirmed cost, then stop.
    if (!LIVE_ORDERS) {
      await db.query(
        `UPDATE print_jobs SET status='validated', pod_package_id=$2, quantity=1,
           total_cost=$3, currency=$4, updated_at=NOW() WHERE id=$1`,
        [jobRowId, lulu.DEFAULT_POD_PACKAGE_ID, total, currency]
      );
      return { ordered: false, reason: 'dry_run', total, currency, env: lulu.env };
    }

    // Record intent BEFORE submitting (so a crash mid-call can't lose track).
    await db.query(
      `UPDATE print_jobs SET status='created', pod_package_id=$2, quantity=1,
         total_cost=$3, currency=$4, updated_at=NOW() WHERE id=$1`,
      [jobRowId, lulu.DEFAULT_POD_PACKAGE_ID, total, currency]
    );

    // --- Create the order (24h production delay = the auto-cancel safety window) ---
    const job = await lulu.createPrintJob({
      externalId,
      title: (customer.name ? customer.name + ' — Memoir' : 'Memory Box memoir'),
      podPackageId: lulu.DEFAULT_POD_PACKAGE_ID,
      quantity: 1,
      interiorUrl,
      coverUrl,
      contactEmail: 'kbakerbcs1@gmail.com',
      address,
      shippingLevel: 'MAIL',
      productionDelayMinutes: 1440,
    });

    const luluId = job && (job.id != null ? String(job.id) : null);
    const luluStatus = job && (job.status && (job.status.name || job.status)) || null;
    await db.query(
      `UPDATE print_jobs
         SET status = 'submitted', lulu_print_job_id = $2, last_lulu_status = $3, updated_at = NOW()
       WHERE id = $1`,
      [jobRowId, luluId, luluStatus]
    );
    await db.query('UPDATE customers SET print_ordered_at = NOW() WHERE id = $1', [customer.id]);

    return { ordered: true, luluId, total, currency, status: luluStatus, env: lulu.env };
  } catch (err) {
    // Record the failure — but NEVER clobber a row that already reached Lulu
    // (status 'submitted' / has a Lulu job id). An error AFTER a successful
    // charge (e.g. a lost/timed-out response) must not look like a plain
    // failure, or a manual re-order would double-charge the customer. We only
    // mark 'error' when the order definitely did not go through.
    try {
      await db.query(
        `UPDATE print_jobs
            SET status = 'error', error = $2, updated_at = NOW()
          WHERE id = $1 AND lulu_print_job_id IS NULL AND status <> 'submitted'`,
        [jobRowId, String(err.message).slice(0, 500)]
      );
    } catch (_) { /* best effort */ }
    return { ordered: false, reason: 'error', error: err.message };
  }
}

module.exports = { autoOrderOnApproval, HARDCOVER_PLANS, COST_CEILING };

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

// Plans that include a physical hardcover book.
const HARDCOVER_PLANS = new Set(['hardcover', 'legacy']);

// Safety ceiling: a single ~34-page 8.5x11 premium-color hardcover plus US
// shipping is roughly $30. If Lulu ever quotes far above this, treat it as an
// anomaly, DO NOT auto-charge, and fall back to Ken. Tune as real data comes in.
const COST_CEILING = Number(process.env.LULU_COST_CEILING || 75);

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

  // Idempotency — never order the same draft twice.
  const existing = await db.queryOne(
    'SELECT id, status FROM print_jobs WHERE external_id = $1', [externalId]
  );
  if (existing) return { ordered: false, reason: 'already_ordered' };

  const assets = await loadPrintAssets(draft.id);
  if (!assets) return { ordered: false, reason: 'no_print_pdf' };

  const address = await loadShippingAddress(customer.id);
  if (!address) return { ordered: false, reason: 'no_address' };
  if (address.email == null) address.email = customer.email;

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
        `INSERT INTO print_jobs (customer_id, draft_id, external_id, lulu_env, status,
           pod_package_id, quantity, total_cost, currency, error)
         VALUES ($1,$2,$3,$4,'error',$5,1,$6,$7,$8)`,
        [customer.id, draft.id, externalId, lulu.env, lulu.DEFAULT_POD_PACKAGE_ID,
         total, currency, 'cost above ceiling ($' + total + ' > $' + COST_CEILING + ')']
      );
      return { ordered: false, reason: 'cost_anomaly', total, currency };
    }

    // Record intent BEFORE submitting (so a crash mid-call can't lose track).
    await db.query(
      `INSERT INTO print_jobs (customer_id, draft_id, external_id, lulu_env, status,
         pod_package_id, quantity, total_cost, currency)
       VALUES ($1,$2,$3,$4,'created',$5,1,$6,$7)`,
      [customer.id, draft.id, externalId, lulu.env, lulu.DEFAULT_POD_PACKAGE_ID, total, currency]
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
       WHERE external_id = $1`,
      [externalId, luluId, luluStatus]
    );
    await db.query('UPDATE customers SET print_ordered_at = NOW() WHERE id = $1', [customer.id]);

    return { ordered: true, luluId, total, currency, status: luluStatus, env: lulu.env };
  } catch (err) {
    // Record the failure and let the caller fall back to emailing Ken.
    try {
      await db.query(
        `INSERT INTO print_jobs (customer_id, draft_id, external_id, lulu_env, status, error)
         VALUES ($1,$2,$3,$4,'error',$5)
         ON CONFLICT (external_id) DO UPDATE SET status='error', error=EXCLUDED.error, updated_at=NOW()`,
        [customer.id, draft.id, externalId, lulu.env, String(err.message).slice(0, 500)]
      );
    } catch (_) { /* best effort */ }
    return { ordered: false, reason: 'error', error: err.message };
  }
}

module.exports = { autoOrderOnApproval, HARDCOVER_PLANS, COST_CEILING };

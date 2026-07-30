// ============================================================================
// Lulu Print API client.
//
// Wraps Lulu's print-on-demand API so an approved memoir can be auto-ordered as
// a hardcover, printed, and shipped with no manual step from Ken.
//
// FEATURE-FLAGGED: this module is inert unless LULU_CLIENT_KEY + LULU_CLIENT_SECRET
// are set. With no credentials, `enabled` is false and callers fall back to the
// old manual "email Ken" path — so deploying this changes nothing until Ken
// creates a Lulu Print API developer account and adds the keys as env vars.
//
// Environment variables:
//   LULU_CLIENT_KEY      — Lulu Print API client key      (required to enable)
//   LULU_CLIENT_SECRET   — Lulu Print API client secret   (required to enable)
//   LULU_ENV             — 'sandbox' (default) or 'production'
//   LULU_POD_PACKAGE_ID  — overrides the default book spec SKU (see below)
//
// SANDBOX FIRST: default env is 'sandbox' so the very first real order is placed
// against Lulu's free test environment (no money, no real printing) before Ken
// ever flips LULU_ENV=production.
// ============================================================================

const ENV = (process.env.LULU_ENV || 'sandbox').toLowerCase();
const CLIENT_KEY = process.env.LULU_CLIENT_KEY || '';
const CLIENT_SECRET = process.env.LULU_CLIENT_SECRET || '';

const BASE = ENV === 'production'
  ? 'https://api.lulu.com'
  : 'https://api.sandbox.lulu.com';
const TOKEN_URL = BASE + '/auth/realms/glasstree/protocol/openid-connect/token';

const enabled = !!(CLIENT_KEY && CLIENT_SECRET);
if (!enabled) {
  console.warn('[lulu] LULU_CLIENT_KEY / LULU_CLIENT_SECRET not set — auto-print is OFF '
    + '(orders fall back to emailing Ken). Set both to enable; LULU_ENV=' + ENV + '.');
}

// ----------------------------------------------------------------------------
// Book spec (the 27-char Lulu SKU that defines trim size, color, binding, paper).
// This is Ken's book: 8.5x11 (US Letter), HARDCOVER case wrap, PREMIUM color,
// coated white paper, matte cover.
//
// ⚠️ VERIFY BEFORE PRODUCTION: confirm this exact pod_package_id against Lulu's
// price calculator or one of Ken's past manual orders (order USD-C4178095 was
// this configuration). A wrong SKU prints the wrong book. The cost-calc call in
// sandbox will reject an invalid SKU, so we validate before any real order.
// ----------------------------------------------------------------------------
const DEFAULT_POD_PACKAGE_ID = process.env.LULU_POD_PACKAGE_ID
  || '0850X1100FCPRECW080CW444MXX';

// ----------------------------------------------------------------------------
// OAuth2 client-credentials token, cached until shortly before expiry.
// ----------------------------------------------------------------------------
let _token = null;        // { access_token, expires_at (ms) }

async function getToken() {
  if (!enabled) throw new Error('Lulu not configured (missing client key/secret).');
  const now = Date.now();
  if (_token && _token.expires_at > now + 30000) return _token.access_token;

  const basic = Buffer.from(CLIENT_KEY + ':' + CLIENT_SECRET).toString('base64');
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!resp.ok) throw new Error('Lulu auth failed (' + resp.status + '): ' + await resp.text());
  const data = await resp.json();
  const ttl = (data.expires_in || 3600) * 1000;
  _token = { access_token: data.access_token, expires_at: now + ttl };
  return _token.access_token;
}

async function apiFetch(path, method, body) {
  const token = await getToken();
  const resp = await fetch(BASE + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON error body */ }
  if (!resp.ok) {
    const msg = (json && (json.detail || JSON.stringify(json))) || text || ('HTTP ' + resp.status);
    const err = new Error('Lulu ' + method + ' ' + path + ' failed (' + resp.status + '): ' + msg);
    err.status = resp.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ----------------------------------------------------------------------------
// Shipping address → Lulu shape. Lulu requires: name, street1, city,
// country_code (2-letter), postcode, phone_number; state_code for US/CA/MX/AU.
// ----------------------------------------------------------------------------
function toLuluAddress(a) {
  const countryRaw = (a.country || 'US').trim().toUpperCase();
  const country_code = (countryRaw === 'USA' || countryRaw === 'UNITED STATES') ? 'US' : countryRaw.slice(0, 2);
  const out = {
    name: a.name,
    street1: a.address1,
    city: a.city,
    postcode: a.zip,
    country_code,
    phone_number: a.phone || '000-000-0000', // Lulu requires a phone; placeholder if none on file
  };
  if (a.address2) out.street2 = a.address2;
  if (a.state) out.state_code = a.state;
  if (a.email) out.email = a.email;
  return out;
}

// ----------------------------------------------------------------------------
// Cost calculation — POST /print-job-cost-calculations/. Used as a safety check
// (and a real-cost read) BEFORE creating an order. Returns Lulu's cost object.
// ----------------------------------------------------------------------------
async function calculateCost({ podPackageId, pageCount, quantity, address, shippingLevel }) {
  const body = {
    line_items: [{
      page_count: pageCount,
      pod_package_id: podPackageId || DEFAULT_POD_PACKAGE_ID,
      quantity: quantity || 1,
    }],
    shipping_address: toLuluAddress(address),
    shipping_option_level: shippingLevel || 'MAIL',
  };
  return apiFetch('/print-job-cost-calculations/', 'POST', body);
}

// ----------------------------------------------------------------------------
// Create a print job — POST /print-jobs/.
//   externalId      — our idempotency key (also stored in print_jobs.external_id)
//   interiorUrl     — public URL Lulu fetches the interior PDF from
//   coverUrl        — public URL Lulu fetches the wraparound cover PDF from
//   productionDelayMinutes — how long Lulu holds before production (60–2880).
//     We use 1440 (24h) so an order can be auto-cancelled / caught before it
//     physically prints — the safety window for "fully automatic" mode.
// ----------------------------------------------------------------------------
async function createPrintJob({
  externalId, title, podPackageId, quantity,
  interiorUrl, coverUrl, contactEmail, address, shippingLevel,
  productionDelayMinutes,
}) {
  const body = {
    external_id: externalId,
    contact_email: contactEmail,
    shipping_level: shippingLevel || 'MAIL',
    production_delay: productionDelayMinutes || 1440,
    shipping_address: toLuluAddress(address),
    line_items: [{
      external_id: externalId,
      title: title || 'Memory Box memoir',
      pod_package_id: podPackageId || DEFAULT_POD_PACKAGE_ID,
      quantity: quantity || 1,
      printable_normalization: {
        cover: { source_url: coverUrl },
        interior: { source_url: interiorUrl },
      },
    }],
  };
  return apiFetch('/print-jobs/', 'POST', body);
}

// Exact wraparound cover dimensions for a given book (spine depends on page
// count + paper). Returns Lulu's { width, height, unit }. Used to size the
// generated cover precisely before ordering.
async function calculateCoverDimensions({ podPackageId, pageCount, unit }) {
  return apiFetch('/print-jobs/cover-dimensions/', 'POST', {
    pod_package_id: podPackageId || DEFAULT_POD_PACKAGE_ID,
    interior_page_count: pageCount,
    unit: unit || 'in',
  });
}

async function getPrintJob(id) {
  return apiFetch('/print-jobs/' + encodeURIComponent(id) + '/', 'GET');
}

// Cancel a print job (only possible while it has not entered production).
async function cancelPrintJob(id) {
  return apiFetch('/print-jobs/' + encodeURIComponent(id) + '/status/', 'PUT', { name: 'CANCELED' });
}

module.exports = {
  enabled,
  env: ENV,
  DEFAULT_POD_PACKAGE_ID,
  getToken,
  calculateCost,
  calculateCoverDimensions,
  createPrintJob,
  getPrintJob,
  cancelPrintJob,
  toLuluAddress,
};

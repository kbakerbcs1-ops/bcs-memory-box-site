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
// .trim() defends against a stray space or newline getting pasted with the key.
const CLIENT_KEY = (process.env.LULU_CLIENT_KEY || '').trim();
const CLIENT_SECRET = (process.env.LULU_CLIENT_SECRET || '').trim();
// Preferred: the single "Base64 Encoded Key & Secret" string Lulu shows on the
// API Keys page (with or without the leading "Basic "). If set, we use it as the
// auth header directly — no key/secret pairing to get wrong. Falls back to
// computing it from CLIENT_KEY:CLIENT_SECRET.
const BASIC_AUTH = (process.env.LULU_BASIC_AUTH || '').trim();
function authHeader() {
  if (BASIC_AUTH) return /^basic\s/i.test(BASIC_AUTH) ? BASIC_AUTH : ('Basic ' + BASIC_AUTH);
  return 'Basic ' + Buffer.from(CLIENT_KEY + ':' + CLIENT_SECRET).toString('base64');
}

const BASE = ENV === 'production'
  ? 'https://api.lulu.com'
  : 'https://api.sandbox.lulu.com';
const TOKEN_URL = BASE + '/auth/realms/glasstree/protocol/openid-connect/token';

const enabled = !!(BASIC_AUTH || (CLIENT_KEY && CLIENT_SECRET));
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

// All Lulu HTTP calls go through this so a hung/slow connection can never block
// a request — or the customer's approval flow — forever. Aborts after `ms`
// (default 30s) and reports a clear timeout error instead of hanging.
async function luluFetch(url, opts, ms = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error('Lulu request timed out after ' + Math.round(ms / 1000) + 's');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function getToken() {
  if (!enabled) throw new Error('Lulu not configured (missing client key/secret).');
  const now = Date.now();
  if (_token && _token.expires_at > now + 30000) return _token.access_token;

  // Try HTTP Basic auth first (Lulu's documented method). If that's rejected,
  // fall back to sending the credentials in the body (client_secret_post) — this
  // covers either Keycloak client-auth configuration without guesswork.
  let resp = await luluFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Authorization': authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  // Fallback only makes sense when we have the raw key+secret (not a pre-made Basic string).
  if (!resp.ok && (resp.status === 400 || resp.status === 401) && CLIENT_KEY && CLIENT_SECRET && !BASIC_AUTH) {
    resp = await luluFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
        + '&client_id=' + encodeURIComponent(CLIENT_KEY)
        + '&client_secret=' + encodeURIComponent(CLIENT_SECRET),
    });
  }
  if (!resp.ok) throw new Error('Lulu auth failed (' + resp.status + '): ' + await resp.text());
  const data = await resp.json();
  const ttl = (data.expires_in || 3600) * 1000;
  _token = { access_token: data.access_token, expires_at: now + ttl };
  return _token.access_token;
}

async function apiFetch(path, method, body) {
  const token = await getToken();
  const resp = await luluFetch(BASE + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // Lulu sits behind Cloudflare, which 403s (error 1010) requests that
      // arrive with no/odd User-Agent. Send a normal one.
      'User-Agent': 'BCSMemoryBox/1.0 (+https://www.bcsmemorybox.com)',
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
    shipping_level: shippingLevel || 'MAIL',
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
        // Lulu's print-jobs validator requires pod_package_id INSIDE
        // printable_normalization when the full cover/interior form is used
        // (its 400 was: line_items[].printable_normalization.pod_package_id
        // "This field is required."). We also keep it at the line-item top
        // level, where the OpenAPI spec lists it — satisfies both.
        pod_package_id: podPackageId || DEFAULT_POD_PACKAGE_ID,
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
// Lulu's authoritative cover size for a given book + interior page count.
// NOTE: the endpoint is '/cover-dimensions/' at the API ROOT — NOT under
// '/print-jobs/'. The old path returned 405 on every call, the caller swallowed
// the error, and we shipped covers sized by the offline formula instead. That
// is exactly how Kelly Wright's first real order was REJECTED (Aug 14, 2026):
// the formula produced a 19.236in cover for 66 pages when Lulu required 19.00in.
// Lulu answers in POINTS (72 per inch); we normalise to inches here so callers
// cannot repeat that unit mix-up.
async function calculateCoverDimensions({ podPackageId, pageCount }) {
  const raw = await apiFetch('/cover-dimensions/', 'POST', {
    pod_package_id: podPackageId || DEFAULT_POD_PACKAGE_ID,
    interior_page_count: pageCount,
  });
  const unit = String((raw && raw.unit) || 'pt').toLowerCase();
  const div = (unit === 'pt' || unit === 'point' || unit === 'points') ? 72 : 1;
  const widthIn = Number(raw && raw.width) / div;
  const heightIn = Number(raw && raw.height) / div;
  if (!isFinite(widthIn) || !isFinite(heightIn) || widthIn <= 0 || heightIn <= 0) {
    throw new Error('Lulu cover-dimensions returned an unusable size: ' + JSON.stringify(raw));
  }
  return { widthIn, heightIn, raw };
}

// Pull the useful facts out of a Lulu print-job response. ONE extractor, used by
// both the watchdog and the admin refresh, so the two can never drift apart.
// Everything is best-effort: Lulu's shape varies by status and a missing field
// must never throw.
function summarizeJob(remote) {
  const out = {
    status: null, tracking_url: null, tracking_id: null, carrier: null,
    shipping_level: null, is_cancellable: null,
    dispatch_min: null, dispatch_max: null, arrival_min: null, arrival_max: null,
  };
  if (!remote || typeof remote !== 'object') return out;
  try {
    out.status = (remote.status && (remote.status.name || remote.status)) || null;
    out.shipping_level = remote.shipping_level || remote.shipping_option_level || null;
    out.is_cancellable = (typeof remote.is_cancellable === 'boolean') ? remote.is_cancellable : null;
    const d = remote.estimated_shipping_dates || {};
    out.dispatch_min = d.dispatch_min || null;
    out.dispatch_max = d.dispatch_max || null;
    out.arrival_min = d.arrival_min || null;
    out.arrival_max = d.arrival_max || null;
    const li = (remote.line_items && remote.line_items[0]) || {};
    out.tracking_url = (li.tracking_urls && li.tracking_urls[0])
      || (remote.tracking_urls && remote.tracking_urls[0]) || null;
    out.tracking_id = li.tracking_id || null;
    out.carrier = li.carrier_name || null;
  } catch (_) { /* best effort by design */ }
  return out;
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
  summarizeJob,
  cancelPrintJob,
  toLuluAddress,
};

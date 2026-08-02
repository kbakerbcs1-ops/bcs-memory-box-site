// ============================================================================
// SINGLE SOURCE OF TRUTH for pricing + product facts.
//
// Change the price or the product description HERE, in ONE place. The free-trial
// sample email, the Stripe checkout line item, and Ken's "new customer paid"
// notice all read from this file — so they can never drift apart again (which
// is exactly how the stale "$125" slipped into the trial email while the site
// said $299).
//
// If you add a NEW place that mentions the price or the product blurb, import it
// from here instead of typing the number by hand.
// ============================================================================

const HARDCOVER_PRICE_CENTS = 29900; // $299 — the one product we sell
const HARDCOVER_PRICE_USD = HARDCOVER_PRICE_CENTS / 100; // 299
const EXTRA_COPY_PRICE_USD = 99; // $99 per additional hardcover copy

const PRODUCT_NAME = 'Hardcover Memoir';

// The canonical product description, reused by the trial email + Stripe line item.
const PRODUCT_DESC =
  'Your finished memoir in your own voice, organized into chapters, delivered ' +
  'as a professionally printed hardcover book (one copy included) — with two ' +
  'rounds of revisions, and photographs included free.';

// Plans. 'hardcover' is the ONLY sellable plan.
// 'story' and 'legacy' are RETIRED: kept here ONLY so a few legacy/test customer
// records that still carry those values resolve without error. New signups can
// never be assigned them (see ALLOWED_PLANS / DEFAULT_PLAN), and a retired-plan
// customer who somehow reaches checkout is charged as Hardcover, not the old price.
const PLANS = {
  hardcover: {
    cents: HARDCOVER_PRICE_CENTS,
    name: PRODUCT_NAME + ' — BCS Memory Box',
    desc: PRODUCT_DESC,
  },
  // ---- retired (never offered to new customers) ----
  story:  { cents: 17500, name: 'Digital Keepsake — BCS Memory Box', desc: 'Retired plan (digital only).', retired: true },
  legacy: { cents: 49900, name: 'Family Legacy — BCS Memory Box',   desc: 'Retired plan.',                retired: true },
};

const DEFAULT_PLAN = 'hardcover';          // what an unset/invalid plan becomes
const ALLOWED_PLANS = ['hardcover'];       // what a NEW signup is allowed to choose
const HARDCOVER_PLANS = new Set(['hardcover', 'legacy']); // plans that include a printed book

// Price tokens that must NEVER reappear in customer-facing copy or email
// templates. The content-guard (scripts/check-content.js) fails the check if it
// finds any of these, so a retired price can't silently creep back in.
const RETIRED_PRICE_TOKENS = ['$125', '$175', '$499', '$49'];

// Resolve a stored plan value to a *sellable* plan key for checkout:
// unknown or retired -> the default ($299 Hardcover).
function sellablePlanKey(storedPlan) {
  const p = PLANS[storedPlan];
  return (p && !p.retired) ? storedPlan : DEFAULT_PLAN;
}

module.exports = {
  HARDCOVER_PRICE_CENTS,
  HARDCOVER_PRICE_USD,
  EXTRA_COPY_PRICE_USD,
  PRODUCT_NAME,
  PRODUCT_DESC,
  PLANS,
  DEFAULT_PLAN,
  ALLOWED_PLANS,
  HARDCOVER_PLANS,
  RETIRED_PRICE_TOKENS,
  sellablePlanKey,
};

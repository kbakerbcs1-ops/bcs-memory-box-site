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

// Plans. 'hardcover' is the ONLY plan — we sell one product, the $299 Hardcover
// Memoir. The old 'story' ($175) and 'legacy' ($499) tiers were fully retired on
// Aug 2, 2026 (all legacy test records migrated to hardcover first, then the
// definitions removed). sellablePlanKey() still maps any unexpected/blank stored
// value to hardcover, so nothing can ever fall through to a wrong price.
const PLANS = {
  hardcover: {
    cents: HARDCOVER_PRICE_CENTS,
    name: PRODUCT_NAME + ' — BCS Memory Box',
    desc: PRODUCT_DESC,
  },
};

const DEFAULT_PLAN = 'hardcover';          // what an unset/invalid plan becomes
const ALLOWED_PLANS = ['hardcover'];       // what a NEW signup is allowed to choose
const HARDCOVER_PLANS = new Set(['hardcover']); // plans that include a printed book

// Price tokens that must NEVER reappear in customer-facing copy or email
// templates. The content-guard (scripts/check-content.js) fails the check if it
// finds any of these, so a retired price can't silently creep back in.
const RETIRED_PRICE_TOKENS = ['$125', '$175', '$499', '$49'];

// Resolve a stored plan value to a valid plan key for checkout:
// anything unknown/blank -> the default ($299 Hardcover). Since 'hardcover' is
// the only plan, this effectively guarantees the $299 price for everyone.
function sellablePlanKey(storedPlan) {
  return PLANS[storedPlan] ? storedPlan : DEFAULT_PLAN;
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

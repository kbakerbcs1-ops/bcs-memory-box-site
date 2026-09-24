-- 018_plan_default_hardcover: stop new customers being created on a retired plan.
--
-- WHY THIS EXISTS
-- Migration 005 added the column as `plan TEXT NOT NULL DEFAULT 'story'`, back when
-- 'story' was a real tier ($175 Digital Keepsake, no printed book). On 2026-08-02 the
-- 'story' and 'legacy' tiers were retired and removed from lib/pricing.js, leaving
-- HARDCOVER_PLANS = {hardcover}. The SIGNUP route was updated to send 'hardcover'
-- explicitly, but two things were missed:
--   1. this column default, which still said 'story'; and
--   2. the admin "add a free tester" INSERT, which never set plan at all and so
--      silently inherited that default.
--
-- The effect on anyone created that way was invisible but total:
--   customer.js  -> includesHardcover = false
--   yourstory.html renderShippingForm() -> returns '' (NO mailing-address form)
--   printOrder.js -> reason 'digital_plan' -> NO BOOK IS EVER ORDERED
-- and there is no way in the dashboard to change a customer's plan afterwards.
--
-- The six affected rows were repaired in August by hand, directly in the database.
-- That repair was never written into a migration, so it did not survive the
-- 2026-09-15 rebuild onto a new server with a fresh database, and the fault
-- reappeared for the next tester added from the dashboard.
--
-- This migration is that repair, written down, so it survives the next rebuild.
-- Idempotent: safe to run repeatedly.

ALTER TABLE customers ALTER COLUMN plan SET DEFAULT 'hardcover';

-- 'hardcover' is the ONLY sellable plan (lib/pricing.js ALLOWED_PLANS), so any other
-- stored value is a retired tier and must not block that customer's book.
UPDATE customers SET plan = 'hardcover' WHERE plan <> 'hardcover';

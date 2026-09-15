-- 016: Email bounce tracking (Sept 15 2026).
--
-- WHY: a tester signed up on Aug 15 2026 with an address that did not exist.
-- Every email bounced, the system had no way to know, and she looked like a
-- customer ignoring us for two weeks. Resend now reports undeliverable mail to
-- POST /api/email/webhook (routes/emailWebhook.js), and it is recorded here.
--
-- Like customer_reminders (013), this deliberately does NOT write to the
-- customers row: customers has an updated_at trigger, and the reminder sweep
-- and the stuck-processing reaper both read updated_at. A bounce must not
-- reset those clocks. Dead addresses are keyed by the lowercased address, so
-- correcting a customer's email clears the flag automatically.

-- Every event Resend sends, once each (svix_id dedupes Resend's retries).
CREATE TABLE IF NOT EXISTS email_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  svix_id         TEXT NOT NULL UNIQUE,
  event_type      TEXT NOT NULL,
  resend_email_id TEXT,
  to_addresses    TEXT[] NOT NULL DEFAULT '{}',
  bounce_type     TEXT,
  detail          TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Addresses known to be unreachable: permanent bounce, suppressed, failed
-- send, or a spam complaint. One row per address.
CREATE TABLE IF NOT EXISTS email_dead_addresses (
  email         TEXT PRIMARY KEY,   -- always lowercased
  reason        TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

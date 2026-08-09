-- 013: Customer re-engagement reminders (audit C5).
--
-- The reminder sweep must know who it has already nudged, so it never
-- double-sends. We deliberately DO NOT store this on the customers row:
-- customers has an updated_at trigger that fires on ANY update, and the sweep
-- uses updated_at to measure "how long has this person been stuck." Writing
-- reminder bookkeeping onto the customer would reset that clock. So reminders
-- live in their own append-only log.

-- One row per reminder actually sent. `kind` is the reminder type
-- (e.g. 'follow_up', 'recording', 'delivered', 'error_customer', 'error_ken'),
-- which is usually the customer's status but lets one status drive more than
-- one kind of message (error nudges both the customer and Ken).
CREATE TABLE IF NOT EXISTS customer_reminders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customer_reminders_lookup
  ON customer_reminders(customer_id, kind, sent_at);

-- One row per sweep run — doubles as an audit trail AND lets the boot
-- catch-up ask "when did the last sweep actually run?" so reminders still
-- go out even if the in-process daily timer is reset by a restart.
CREATE TABLE IF NOT EXISTS reminder_sweeps (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dry_run    BOOLEAN NOT NULL DEFAULT TRUE,
  sent_count INTEGER NOT NULL DEFAULT 0,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminder_sweeps_ran_at ON reminder_sweeps(ran_at);

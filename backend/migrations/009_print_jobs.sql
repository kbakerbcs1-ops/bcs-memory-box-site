-- 009_print_jobs.sql
-- Tracks automatic hardcover orders placed with Lulu when a customer approves
-- their book. One row per Lulu print job. external_id is our idempotency key,
-- so a given draft can never be ordered twice.
--
-- NOTE: customers.id and drafts.id are UUID (see 001_initial_schema.sql), so the
-- foreign keys here must be UUID too.

CREATE TABLE IF NOT EXISTS print_jobs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  draft_id           UUID REFERENCES drafts(id) ON DELETE SET NULL,
  external_id        TEXT UNIQUE NOT NULL,       -- our key, e.g. 'book-<customerId>-<draftId>'
  lulu_print_job_id  TEXT,                       -- Lulu's numeric job id (as text)
  lulu_env           TEXT,                       -- 'sandbox' | 'production'
  status             TEXT NOT NULL DEFAULT 'created', -- created | submitted | error | canceled
  pod_package_id     TEXT,
  quantity           INTEGER NOT NULL DEFAULT 1,
  total_cost         NUMERIC(10,2),              -- Lulu's total incl. shipping/tax
  currency           TEXT,
  last_lulu_status   TEXT,                       -- latest status from Lulu (UNPAID, IN_PRODUCTION, SHIPPED, ...)
  tracking_url       TEXT,
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS print_jobs_customer_idx ON print_jobs(customer_id);

-- When the automatic order was placed (null = not ordered yet / fell back to manual).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS print_ordered_at TIMESTAMPTZ;

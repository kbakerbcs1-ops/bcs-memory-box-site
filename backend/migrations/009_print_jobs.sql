-- 009_print_jobs.sql
-- Tracks automatic hardcover orders placed with Lulu when a customer approves
-- their book. One row per Lulu print job. external_id is our idempotency key,
-- so a given draft can never be ordered twice.

CREATE TABLE IF NOT EXISTS print_jobs (
  id                 SERIAL PRIMARY KEY,
  customer_id        INTEGER NOT NULL REFERENCES customers(id),
  draft_id           INTEGER,
  external_id        TEXT UNIQUE NOT NULL,       -- our key, e.g. 'book-<customerId>-<draftId>'
  lulu_print_job_id  TEXT,                       -- Lulu's numeric job id (as text)
  lulu_env           TEXT,                       -- 'sandbox' | 'production'
  status             TEXT NOT NULL DEFAULT 'created', -- our lifecycle: created|submitted|error|canceled + Lulu status echoes
  pod_package_id     TEXT,
  quantity           INTEGER NOT NULL DEFAULT 1,
  total_cost         NUMERIC(10,2),              -- Lulu's total incl. shipping/tax, in currency below
  currency           TEXT,
  last_lulu_status   TEXT,                       -- most recent status pulled from Lulu (UNPAID, IN_PRODUCTION, SHIPPED, ...)
  tracking_url       TEXT,
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS print_jobs_customer_idx ON print_jobs(customer_id);

-- When the automatic order was placed (null = not ordered yet / fell back to manual).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS print_ordered_at TIMESTAMPTZ;

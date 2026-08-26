-- Keep what Lulu actually tells us about a print job.
--
-- We were calling Lulu, reading ONLY status.name, and throwing the rest away —
-- including the estimated dispatch/arrival dates, the carrier, the tracking id
-- and whether the order can still be cancelled. So when Kelly's hardcover sat in
-- IN_PRODUCTION for four days there was no way to tell whether that was normal
-- without going and asking Lulu by hand.
ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS lulu_detail            JSONB,
  ADD COLUMN IF NOT EXISTS estimated_dispatch_min TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS estimated_dispatch_max TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS estimated_arrival_min  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS estimated_arrival_max  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS carrier                TEXT,
  ADD COLUMN IF NOT EXISTS tracking_id            TEXT,
  ADD COLUMN IF NOT EXISTS shipping_level         TEXT,
  ADD COLUMN IF NOT EXISTS is_cancellable         BOOLEAN;

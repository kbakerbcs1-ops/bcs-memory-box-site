-- BCS Memory Box — photographs customers add to accompany their memoir.
-- One row per uploaded photo. Mirrors the recordings table. Photos are
-- gathered during the recording phase; Ken places them into the memoir
-- when he polishes the draft.

CREATE TABLE IF NOT EXISTS photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Storage location (R2 key)
  storage_key TEXT NOT NULL,
  original_filename TEXT,
  size_bytes BIGINT,
  content_type TEXT,

  -- Optional one-line caption the customer can add ("Mom and Dad, 1951")
  caption TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_photos_customer ON photos(customer_id);

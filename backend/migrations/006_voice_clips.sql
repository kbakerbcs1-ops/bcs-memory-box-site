-- ============================================================================
-- 006_voice_clips: "The Voice" — QR-in-the-book feature.
--
-- A voice clip is a shareable, PUBLIC link to ONE of a customer's recordings.
-- Ken (admin) generates one for a recording; we print its QR code inside the
-- customer's hardcover book. When a family member scans the QR, they open a
-- simple listen page (listen.html?v=<public_token>) and hear the person in
-- their own voice. No login — the public_token is a long, unguessable string.
--
-- The recording audio still lives in R2; this table just maps a public token
-- to a recording plus the little bit of display text the listen page shows.
-- ============================================================================
CREATE TABLE IF NOT EXISTS voice_clips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,

  -- The public, unguessable token that goes in the QR link.
  public_token TEXT NOT NULL UNIQUE,

  -- Display text for the listen page.
  person_name TEXT,   -- e.g. "Margaret"  -> "Hear Margaret in their own voice"
  label TEXT,         -- optional passage/story label, e.g. "The day we met"

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_clips_customer ON voice_clips(customer_id);
CREATE INDEX IF NOT EXISTS idx_voice_clips_recording ON voice_clips(recording_id);

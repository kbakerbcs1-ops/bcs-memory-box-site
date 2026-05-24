-- BCS Memory Box — initial portal schema
-- Customers, recordings, drafts, admin sessions.

-- ============================================================================
-- customers: anyone who has signed up for Your Story
-- ============================================================================
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,

  -- The magic token in their personal URL. Random, unguessable, long-lived.
  -- They never see a password — the URL is the credential.
  access_token TEXT NOT NULL UNIQUE,

  -- Stripe linkage (filled when checkout completes)
  stripe_customer_id TEXT,
  stripe_payment_intent_id TEXT,
  paid_at TIMESTAMPTZ,

  -- Where the customer is in the journey
  -- awaiting_payment | recording | processing | draft_ready | delivered
  status TEXT NOT NULL DEFAULT 'awaiting_payment',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_access_token ON customers(access_token);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);


-- ============================================================================
-- recordings: audio files customers upload, one row per file
-- ============================================================================
CREATE TABLE IF NOT EXISTS recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Storage location (R2 key, or local path during dev)
  storage_key TEXT NOT NULL,
  original_filename TEXT,
  size_bytes BIGINT,
  duration_seconds NUMERIC,

  -- Transcript pipeline
  transcript TEXT,
  -- pending | transcribing | completed | error
  transcript_status TEXT NOT NULL DEFAULT 'pending',
  transcript_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recordings_customer ON recordings(customer_id);
CREATE INDEX IF NOT EXISTS idx_recordings_transcript_status ON recordings(transcript_status);


-- ============================================================================
-- drafts: generated memoir documents (versioned for revisions)
-- ============================================================================
CREATE TABLE IF NOT EXISTS drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- 1 = initial draft from Claude, 2 = after first revision, etc.
  version INT NOT NULL DEFAULT 1,

  -- The polished markdown source we generate before rendering to .docx
  -- Ken can edit this directly in the admin UI.
  markdown_content TEXT,

  -- Storage key of the rendered .docx file (when generated)
  docx_storage_key TEXT,

  -- generating | ready_for_review | approved | delivered
  status TEXT NOT NULL DEFAULT 'generating',

  approved_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (customer_id, version)
);

CREATE INDEX IF NOT EXISTS idx_drafts_customer ON drafts(customer_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);


-- ============================================================================
-- admin_sessions: simple session tokens for Ken's admin dashboard
-- ============================================================================
CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);


-- ============================================================================
-- updated_at trigger on customers (so we always know when status changed)
-- ============================================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_updated_at ON customers;
CREATE TRIGGER customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

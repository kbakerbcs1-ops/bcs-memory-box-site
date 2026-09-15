-- 017: Customer support inbox (Sept 15 2026).
--
-- WHY: the Project Handbook says Bullet runs customer service and Ken is the
-- last line of defence — but customer mail only ever reached Ken's Gmail, so
-- a customer writing at 8pm on a Saturday waited until Ken opened his laptop.
--
-- Mail to hello@bcsmemorybox.com still forwards to Ken's Gmail exactly as
-- before (the safety net). ImprovMX ALSO forwards a copy to Resend's inbound
-- address; Resend's email.received webhook lands in routes/emailWebhook.js and
-- lib/support.js stores the message here, drafts a reply with Claude, and
-- emails Ken. Nothing is sent to a customer until Ken presses Send in the
-- dashboard (Stage 1 of the support scope: Bullet drafts, Ken approves).

CREATE TABLE IF NOT EXISTS support_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resend_email_id   TEXT NOT NULL UNIQUE,            -- Resend's id; dedupes retries
  from_address      TEXT NOT NULL,                   -- lowercased
  from_name         TEXT,
  subject           TEXT,
  body_text         TEXT,
  message_id        TEXT,                            -- for In-Reply-To threading
  references_header TEXT,
  customer_id       UUID REFERENCES customers(id) ON DELETE SET NULL,

  -- new | draft_ready | sending | replied | closed | ignored
  status            TEXT NOT NULL DEFAULT 'new',
  ignored_reason    TEXT,                            -- e.g. an out-of-office auto-reply

  ai_draft          TEXT,
  needs_ken         BOOLEAN NOT NULL DEFAULT FALSE,  -- money, complaints, anything unsure
  needs_ken_reason  TEXT,
  draft_error       TEXT,

  ack_sent_at       TIMESTAMPTZ,                     -- the optional "got your message" note
  reply_text        TEXT,
  replied_at        TIMESTAMPTZ,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_received ON support_messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_messages_from ON support_messages(from_address, received_at DESC);

-- 007_follow_ups: after the FIRST draft, the app asks the storyteller a few
-- gentle follow-up questions and lets them answer BY VOICE, then rewrites a
-- richer final draft that weaves those answers in. See lib/cleanup.js.
--
-- New customer status value used by this flow: 'follow_up' (status is TEXT, so
-- no enum change needed). Flow:
--   recording -> processing -> (first draft) -> follow_up -> processing -> draft_ready

ALTER TABLE customers ADD COLUMN IF NOT EXISTS follow_up_done BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS follow_up_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  -- the recording that answers this question (null until answered)
  answer_recording_id UUID REFERENCES recordings(id) ON DELETE SET NULL,
  answered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_customer ON follow_up_questions(customer_id);

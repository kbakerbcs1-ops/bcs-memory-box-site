-- Add customer_feedback column to drafts so a customer can write a revision
-- request that gets attached to the draft they're rejecting.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS customer_feedback TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS feedback_received_at TIMESTAMPTZ;

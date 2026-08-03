-- Couples: two people recording together into one joint "Our Life Together" book.
-- is_couple flips the recording guidance, turns on speaker diarization, and
-- routes generation through the two-voice memoir writer. partner_name holds the
-- second storyteller's name (the first is customers.name).

ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_couple BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS partner_name TEXT;

-- Adds the purchased plan/tier to each customer.
-- story = Digital Keepsake ($175) · hardcover = Hardcover Memoir ($299) · legacy = Family Legacy ($499)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'story';

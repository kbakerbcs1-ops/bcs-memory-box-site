-- Adds an optional, customer-editable title to each recording so people can
-- label their memories ("Dad's war story") instead of seeing raw filenames.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS title TEXT;

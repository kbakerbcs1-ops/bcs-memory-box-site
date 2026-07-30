-- 010_print_assets_and_shipping.sql
-- Adds (a) print-ready PDF asset keys + page count on drafts, and (b) the
-- shipping address collected from hardcover customers at approval time.

-- Print-ready assets for a draft (generated for Lulu auto-print).
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS interior_pdf_key TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS cover_pdf_key    TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS page_count       INTEGER;

-- Shipping address for the included hardcover (collected at approval).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ship_name     TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ship_address1 TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ship_address2 TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ship_city     TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ship_state    TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ship_zip      TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ship_country  TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ship_phone    TEXT;

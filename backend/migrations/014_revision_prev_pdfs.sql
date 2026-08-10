-- 014: Keep the PREVIOUS print-ready PDFs across a voice revision (audit H2).
--
-- A voice revision already saves the previous markdown + Word doc so a customer
-- can undo. But it did NOT save the previous print PDFs — so after an Undo, the
-- on-screen memoir reverted while interior_pdf_key/cover_pdf_key still pointed at
-- the revised PDFs. The printed hardcover could then contain the change the
-- customer explicitly undid. These columns let undo restore the matching PDFs,
-- exactly like it already restores the text and the .docx.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS prev_interior_pdf_key TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS prev_cover_pdf_key    TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS prev_page_count       INTEGER;

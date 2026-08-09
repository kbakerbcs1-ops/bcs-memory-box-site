-- 012: Soft-delete for customers.
-- The admin "Delete customer" action now sets deleted_at instead of
-- hard-deleting the row and erasing the customer's R2 audio. That audio is an
-- elderly person's irreplaceable life story — a permanent delete has no undo.
-- Soft-delete hides the customer from the dashboard while keeping every
-- recording, draft, photo, and file fully recoverable. A deliberate, reviewed
-- purge of truly-unwanted rows (e.g. old test accounts) can happen later.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

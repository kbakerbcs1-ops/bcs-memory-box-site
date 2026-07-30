-- Voice revisions + customer self-approval on the memoir draft.
-- Lets a customer speak a change, have the AI apply it and show what changed,
-- keep or undo it, and finally approve their own book — all without Ken.

ALTER TABLE drafts ADD COLUMN IF NOT EXISTS revision_status TEXT NOT NULL DEFAULT 'idle';
-- idle | working | applied | error
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS last_change_summary TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS revision_error TEXT;
-- snapshots kept so a customer can UNDO the last voice change in one tap
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS prev_markdown_content TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS prev_docx_storage_key TEXT;

-- when the customer themselves approved the book as final
ALTER TABLE customers ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

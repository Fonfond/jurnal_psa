-- Soft-delete a permit scan so a mistaken/illegible scan can be replaced.
-- The old row and object remain for audit/retention; only active rows are shown.
ALTER TABLE entry_attachments
    ADD COLUMN deleted_by uuid REFERENCES users (id);

CREATE INDEX entry_attachments_deleted_idx
    ON entry_attachments (entry_id, deleted_at);

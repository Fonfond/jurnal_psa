-- Minimal attachment layer for the demo: a scanned paper permit is attached
-- to an entry. The PDF lives in Object Storage (MinIO/S3), never in PostgreSQL.
CREATE TABLE entry_attachments (
    id uuid PRIMARY KEY,
    entry_id uuid NOT NULL REFERENCES journal_entries (id) ON DELETE CASCADE,
    kind text NOT NULL DEFAULT 'permit_scan',
    mime_type text NOT NULL DEFAULT 'application/pdf',
    pages integer NOT NULL CHECK (pages BETWEEN 1 AND 10),
    sha256 char(64) NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
    status text NOT NULL DEFAULT 'uploaded',
    object_key text NOT NULL,
    created_by uuid NOT NULL REFERENCES users (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT entry_attachments_kind_check CHECK (kind = 'permit_scan'),
    CONSTRAINT entry_attachments_mime_check CHECK (mime_type = 'application/pdf'),
    CONSTRAINT entry_attachments_status_check
        CHECK (status IN ('local', 'uploading', 'uploaded', 'error')),
    CONSTRAINT entry_attachments_entry_sha_uq UNIQUE (entry_id, sha256)
);

CREATE UNIQUE INDEX entry_attachments_one_permit_scan_uq
    ON entry_attachments (entry_id)
    WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX entry_attachments_object_key_uq
    ON entry_attachments (object_key);

CREATE INDEX entry_attachments_entry_idx
    ON entry_attachments (entry_id, created_at);

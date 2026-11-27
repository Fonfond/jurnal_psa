-- 0011: permit PDF and external source integration (OQ-03).
-- `pdf_url`/`pdf_hash`/`pdf_size_bytes` already exist in 0002; this adds the
-- generation metadata used by the signed-URL flow and deep links.

ALTER TABLE permits
    ADD COLUMN pdf_generated_at timestamptz,
    ADD COLUMN pdf_source varchar(20) NOT NULL DEFAULT 'generated'
        CHECK (pdf_source IN ('generated', 'external', 'none'));

CREATE INDEX permits_pdf_idx ON permits (pdf_source)
    WHERE pdf_source <> 'none';

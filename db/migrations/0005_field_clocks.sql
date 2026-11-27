-- 0005: per-field HLC clocks for server-side merge (C-01…C-12)

ALTER TABLE journal_entries
    ADD COLUMN field_clocks jsonb NOT NULL DEFAULT '{}'::jsonb;

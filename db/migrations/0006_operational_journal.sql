-- 0006: operational-journal compliance layer (letter 42-6/35-ЭТ, current 811/903н/894).
-- Additive only: existing entries remain valid and default to event_type = 'work'.

CREATE TYPE journal_event_type_enum AS ENUM (
    'work',
    'command',
    'switching',
    'grounding',
    'incident',
    'other'
);

ALTER TABLE journal_entries
    ADD COLUMN event_type journal_event_type_enum NOT NULL DEFAULT 'work',
    ADD COLUMN event_data jsonb,
    ADD COLUMN journal_seq bigserial,
    ADD COLUMN late_entry boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX journal_entries_journal_seq_uq
    ON journal_entries (journal_seq);
CREATE INDEX journal_entries_event_type_idx
    ON journal_entries (event_type);

CREATE TABLE journal_reviews (
    id uuid PRIMARY KEY,
    journal_key text NOT NULL DEFAULT 'main',
    period_start date NOT NULL,
    period_end date NOT NULL,
    reviewer_id uuid NOT NULL REFERENCES users (id),
    reviewed_at timestamptz NOT NULL DEFAULT now(),
    entries_count integer NOT NULL DEFAULT 0,
    remarks text,
    content_hash char(64) NOT NULL,
    CONSTRAINT journal_reviews_period CHECK (period_start <= period_end)
);

CREATE INDEX journal_reviews_period_idx
    ON journal_reviews (journal_key, period_start DESC, period_end DESC);
CREATE INDEX journal_reviews_reviewer_idx
    ON journal_reviews (reviewer_id, reviewed_at DESC);

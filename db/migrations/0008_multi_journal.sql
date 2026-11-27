-- 0008: multi-journal support (JRN-03, ADR-24).
-- Additive and backward compatible: every existing entry keeps its journal_seq
-- and is attached to the default `main` journal. New journals receive their own
-- independent numbering through journal_counters + a BEFORE INSERT trigger.
-- Chosen as 0008 because 0007 is the auth-platform migration (t2).

CREATE TABLE journals (
    id uuid PRIMARY KEY,
    journal_key varchar(64) NOT NULL UNIQUE,
    name varchar(200) NOT NULL,
    description varchar(500),
    active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 100,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT journals_key_format CHECK (journal_key ~ '^[a-z0-9][a-z0-9_-]*$')
);

INSERT INTO journals (id, journal_key, name, description, active, sort_order)
VALUES (
    '01930000-0000-7000-8000-000000001001',
    'main',
    'Основной оперативный журнал',
    'Журнал по умолчанию для записей без явного journal_id',
    true,
    10
);

CREATE TABLE journal_members (
    journal_id uuid NOT NULL REFERENCES journals (id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    access_level varchar(10) NOT NULL DEFAULT 'write'
        CHECK (access_level IN ('read', 'write', 'manage')),
    granted_by uuid REFERENCES users (id),
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (journal_id, user_id)
);

CREATE INDEX journal_members_user_idx ON journal_members (user_id);

ALTER TABLE journal_entries
    ADD COLUMN journal_id uuid NOT NULL
        DEFAULT '01930000-0000-7000-8000-000000001001'
        REFERENCES journals (id);

-- journal_seq is now allocated per journal instead of by a global bigserial.
ALTER TABLE journal_entries ALTER COLUMN journal_seq DROP DEFAULT;
DROP INDEX journal_entries_journal_seq_uq;
CREATE UNIQUE INDEX journal_entries_journal_seq_uq
    ON journal_entries (journal_id, journal_seq)
    WHERE journal_seq IS NOT NULL;
CREATE INDEX journal_entries_journal_performed_idx
    ON journal_entries (journal_id, performed_at DESC);
CREATE INDEX journal_entries_journal_status_idx
    ON journal_entries (journal_id, status);

CREATE TABLE journal_counters (
    journal_id uuid PRIMARY KEY REFERENCES journals (id) ON DELETE CASCADE,
    last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Continue numbering after the highest sequence already issued per journal.
INSERT INTO journal_counters (journal_id, last_seq)
SELECT j.id,
       COALESCE(
           (SELECT MAX(e.journal_seq) FROM journal_entries e WHERE e.journal_id = j.id),
           0
       )
  FROM journals j;

CREATE OR REPLACE FUNCTION journal_entries_assign_seq() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    allocated bigint;
BEGIN
    IF NEW.journal_seq IS NULL THEN
        INSERT INTO journal_counters AS counters (journal_id, last_seq)
        VALUES (NEW.journal_id, 1)
        ON CONFLICT (journal_id) DO UPDATE
            SET last_seq = counters.last_seq + 1,
                updated_at = now()
        RETURNING last_seq INTO allocated;
        NEW.journal_seq := allocated;
    ELSE
        -- Explicit sequence values (restore/import/tests) advance the counter.
        INSERT INTO journal_counters AS counters (journal_id, last_seq)
        VALUES (NEW.journal_id, NEW.journal_seq)
        ON CONFLICT (journal_id) DO UPDATE
            SET last_seq = GREATEST(counters.last_seq, EXCLUDED.last_seq),
                updated_at = now();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER journal_entries_assign_seq_trg
    BEFORE INSERT ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION journal_entries_assign_seq();

-- An entry never moves between journals: numbering and access would break.
CREATE OR REPLACE FUNCTION journal_entries_journal_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.journal_id IS DISTINCT FROM OLD.journal_id THEN
        RAISE EXCEPTION 'journal_id is immutable (entry %)', OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER journal_entries_journal_immutable_trg
    BEFORE UPDATE OF journal_id ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION journal_entries_journal_immutable();

ALTER TABLE journal_reviews
    ADD COLUMN journal_id uuid NOT NULL
        DEFAULT '01930000-0000-7000-8000-000000001001'
        REFERENCES journals (id);

CREATE INDEX journal_reviews_journal_idx
    ON journal_reviews (journal_id, period_start DESC, period_end DESC);

INSERT INTO dictionary_versions (name, version, updated_at)
VALUES ('journals', 1, now())
ON CONFLICT (name) DO NOTHING;

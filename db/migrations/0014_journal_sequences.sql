-- 0014: per-journal sequence for batch journal_seq allocation (t17).
-- A table row lock on journal_counters serialized whole push batches; a
-- PostgreSQL sequence gives non-transactional, lock-free block allocation.
-- journal_counters is kept for compatibility/backfill only.

CREATE OR REPLACE FUNCTION journal_seq_sequence_name(journal_id uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT 'journal_seq_' || replace(journal_id::text, '-', '_');
$$;

DO $$
DECLARE
    journal record;
    seq_name text;
    max_seq bigint;
BEGIN
    FOR journal IN SELECT id FROM journals LOOP
        seq_name := journal_seq_sequence_name(journal.id);
        SELECT coalesce(max(journal_seq), 0) INTO max_seq
          FROM journal_entries WHERE journal_id = journal.id;
        EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I', seq_name);
        IF max_seq > 0 THEN
            EXECUTE format('SELECT setval(%L, %s, true)', seq_name, max_seq);
        ELSE
            EXECUTE format('SELECT setval(%L, 1, false)', seq_name);
        END IF;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION journal_entries_assign_seq() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    seq_name text;
    allocated bigint;
BEGIN
    IF NEW.journal_seq IS NULL THEN
        seq_name := journal_seq_sequence_name(NEW.journal_id);
        IF to_regclass(seq_name) IS NULL THEN
            SELECT coalesce(last_seq, 0) + 1 INTO allocated
              FROM journal_counters WHERE journal_id = NEW.journal_id;
            EXECUTE format('CREATE SEQUENCE %I START WITH %s',
                           seq_name, coalesce(allocated, 1));
        END IF;
        EXECUTE format('SELECT nextval(%L)', seq_name) INTO allocated;
        NEW.journal_seq := allocated;
    END IF;
    RETURN NEW;
END;
$$;

-- The trigger is already attached; recreate it against the new function.
DROP TRIGGER IF EXISTS journal_entries_assign_seq_trg ON journal_entries;
DROP TRIGGER IF EXISTS journal_entries_seq_trg ON journal_entries;
CREATE TRIGGER journal_entries_assign_seq_trg
    BEFORE INSERT ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION journal_entries_assign_seq();

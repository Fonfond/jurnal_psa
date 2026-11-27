-- 0016: block/sequence journal_seq with explicit gap policy (t29).
-- 0015 made numbering gapless but serialized every push on journal_counters
-- (p95 620 ms). This migration returns to per-journal sequences for batch
-- allocation: numbers are unique and monotonic, but a fully rolled-back or
-- crashed batch can leave gaps (documented policy, accepted by the task).
-- journal_counters stays backfilled/legacy (0015) and is not used for new
-- inserts; 0015's audit_outbox is unchanged.

DO $$
DECLARE
    journal record;
    seq_name text;
    max_seq bigint;
    last_seq bigint;
BEGIN
    FOR journal IN SELECT id FROM journals LOOP
        seq_name := journal_seq_sequence_name(journal.id);
        SELECT coalesce(max(journal_seq), 0) INTO max_seq
          FROM journal_entries WHERE journal_id = journal.id;
        EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I', seq_name);
        IF max_seq = 0 THEN
            EXECUTE format('SELECT setval(%L, 1, false)', seq_name);
        ELSE
            EXECUTE format('SELECT last_value FROM %I', seq_name) INTO last_seq;
            IF max_seq > last_seq THEN
                EXECUTE format('SELECT setval(%L, %s, true)', seq_name, max_seq);
            END IF;
        END IF;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION journal_entries_assign_seq() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    seq_name text;
    max_seq bigint;
    allocated bigint;
BEGIN
    IF NEW.journal_seq IS NULL THEN
        seq_name := journal_seq_sequence_name(NEW.journal_id);
        IF to_regclass(seq_name) IS NULL THEN
            SELECT coalesce(max(journal_seq), 0) INTO max_seq
              FROM journal_entries WHERE journal_id = NEW.journal_id;
            EXECUTE format('CREATE SEQUENCE %I START WITH %s',
                           seq_name, max_seq + 1);
        END IF;
        EXECUTE format('SELECT nextval(%L)', seq_name) INTO allocated;
        NEW.journal_seq := allocated;
    END IF;
    -- Explicit values come from the batch block allocator or restore.
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS journal_entries_assign_seq_trg ON journal_entries;
CREATE TRIGGER journal_entries_assign_seq_trg
    BEFORE INSERT ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION journal_entries_assign_seq();

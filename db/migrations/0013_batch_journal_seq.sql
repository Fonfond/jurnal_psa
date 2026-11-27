-- 0013: batch journal_seq allocation (t17).
-- The sync push reserves a block of sequence numbers per journal inside one
-- transaction and passes explicit journal_seq values. The trigger must then
-- NOT touch journal_counters for those rows (otherwise every row would still
-- serialize on the counter). NULL journal_seq keeps the old single-row path.

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
    END IF;
    -- Explicit values come from the batch allocator, which already advanced
    -- journal_counters by the reserved block.
    RETURN NEW;
END;
$$;

-- The batch allocator updates journal_counters once per journal per push.
-- Keep the counter row hot but small; analyze after migration.
CREATE INDEX IF NOT EXISTS journal_entries_journal_seq_batch_idx
    ON journal_entries (journal_id, journal_seq);

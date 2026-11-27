-- 0015: durable audit outbox + transactional journal_seq allocation (REP-06).
-- Audit events are written to audit_outbox in the SAME transaction as the
-- business change; a single writer delivers them to audit_events atomically
-- (INSERT audit_events + DELETE outbox in one transaction). journal_seq is
-- assigned at the end of the batch from journal_counters, so a full rollback
-- restores the counter and leaves no gaps.

CREATE TABLE audit_outbox (
    id uuid PRIMARY KEY,
    occurred_at timestamptz NOT NULL,
    actor_id uuid NOT NULL REFERENCES users (id),
    actor_role user_role_enum NOT NULL,
    action varchar(40) NOT NULL,
    entity_type varchar(32) NOT NULL,
    entity_id uuid,
    before jsonb,
    after jsonb,
    reason varchar(500),
    source varchar(10) NOT NULL DEFAULT 'server',
    device_id uuid,
    ip inet,
    user_agent varchar(300),
    request_id varchar(64),
    app_version varchar(32),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_outbox_created_idx ON audit_outbox (created_at, id);

-- Temporary negative journal_seq for batch inserts. Values are unique globally
-- and never visible outside the transaction; the final positive number is
-- assigned before COMMIT.
CREATE SEQUENCE journal_entries_temp_seq START WITH 1;

-- Upgrade backfill (0014 -> 0015): 0013/0014 bypassed journal_counters via
-- per-journal sequences, so an upgraded database has counters stuck at 0 while
-- journal_seq can already be 66. Backfill BEFORE the counter-based trigger is
-- enabled, otherwise the first post-upgrade insert is assigned seq=1 and hits
-- journal_entries_journal_seq_uq.
INSERT INTO journal_counters (journal_id, last_seq)
SELECT journal_id, max(journal_seq)::bigint
  FROM journal_entries
 WHERE journal_seq IS NOT NULL
 GROUP BY journal_id
ON CONFLICT (journal_id) DO UPDATE
    SET last_seq = GREATEST(journal_counters.last_seq, EXCLUDED.last_seq),
        updated_at = now();

-- journal_seq for batch pushes is assigned from journal_counters at the end of
-- the transaction (gapless on rollback). Non-batch inserts keep the counter path;
-- explicit values (batch temp negatives / restore) never touch the counter.
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
    RETURN NEW;
END;
$$;

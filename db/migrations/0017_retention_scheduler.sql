-- 0017: daily retention scheduler, TTL counters and alerts (REP-05).
-- Additive: existing manual retention runs keep working (status=success, manual).

ALTER TABLE retention_runs
    ADD COLUMN trigger varchar(10) NOT NULL DEFAULT 'manual'
        CHECK (trigger IN ('manual', 'scheduler')),
    ADD COLUMN status varchar(10) NOT NULL DEFAULT 'success'
        CHECK (status IN ('running', 'success', 'failed')),
    ADD COLUMN run_date date,
    ADD COLUMN duration_ms integer,
    ADD COLUMN error varchar(500);

-- One scheduler run per UTC day. Failed runs are not in the index, so a retry
-- on the same day is allowed; successful/running runs are idempotent.
CREATE UNIQUE INDEX retention_runs_scheduler_day_uq
    ON retention_runs (run_date)
    WHERE trigger = 'scheduler' AND status IN ('running', 'success');

CREATE INDEX retention_runs_status_idx ON retention_runs (status, run_date DESC);

CREATE TABLE retention_alerts (
    id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    kind varchar(40) NOT NULL,
    severity varchar(10) NOT NULL
        CHECK (severity IN ('info', 'warning', 'critical')),
    message varchar(1000) NOT NULL,
    context jsonb NOT NULL DEFAULT '{}'::jsonb,
    delivered_at timestamptz,
    delivery_error varchar(500)
);

CREATE INDEX retention_alerts_created_idx ON retention_alerts (created_at DESC);
CREATE INDEX retention_alerts_kind_idx ON retention_alerts (kind, created_at DESC);

-- TTL may remove expired *non-WORM* export jobs; WORM exports stay immutable.
-- Archive manifests reference their export job with a FK, so WORM/archive rows
-- are additionally protected by referential integrity.
CREATE OR REPLACE FUNCTION export_jobs_worm_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.worm = false THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'WORM: export job % cannot be deleted', OLD.id;
    END IF;
    IF OLD.status = 'done' AND (
        NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256
        OR NEW.file_bytes IS DISTINCT FROM OLD.file_bytes
        OR NEW.csv_bytes IS DISTINCT FROM OLD.csv_bytes
        OR NEW.csv_sha256 IS DISTINCT FROM OLD.csv_sha256
        OR NEW.manifest IS DISTINCT FROM OLD.manifest
        OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.worm IS DISTINCT FROM OLD.worm
    ) THEN
        RAISE EXCEPTION 'WORM: export job % is immutable', OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

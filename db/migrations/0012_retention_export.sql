-- 0012: retention, WORM journal export and backup checkpoints (JRN-04/JRN-07).
-- Additive: existing export_jobs rows stay valid (status queued).

ALTER TYPE signature_entity_type_enum ADD VALUE IF NOT EXISTS 'export';

ALTER TABLE export_jobs
    ADD COLUMN journal_id uuid REFERENCES journals (id),
    ADD COLUMN params jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN file_bytes bytea,
    ADD COLUMN csv_bytes bytea,
    ADD COLUMN file_sha256 char(64),
    ADD COLUMN file_size_bytes integer,
    ADD COLUMN csv_sha256 char(64),
    ADD COLUMN csv_size_bytes integer,
    ADD COLUMN manifest jsonb,
    ADD COLUMN signature_id uuid REFERENCES document_signatures (id),
    ADD COLUMN generated_at timestamptz,
    ADD COLUMN download_count integer NOT NULL DEFAULT 0,
    ADD COLUMN worm boolean NOT NULL DEFAULT false,
    ADD COLUMN error varchar(500);

CREATE INDEX export_jobs_type_idx ON export_jobs (type, status);
CREATE INDEX export_jobs_journal_idx ON export_jobs (journal_id, generated_at DESC);

-- Retention runs keep an immutable report of daily checks / archive runs.
CREATE TABLE retention_runs (
    id uuid PRIMARY KEY,
    run_at timestamptz NOT NULL DEFAULT now(),
    actor_id uuid REFERENCES users (id),
    policy_years integer NOT NULL,
    cutoff date NOT NULL,
    audit_ok boolean NOT NULL,
    streams_checked integer NOT NULL DEFAULT 0,
    report jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX retention_runs_run_idx ON retention_runs (run_at DESC);

-- Backup hooks: a checkpoint seals the current audit/exports manifest.
CREATE TABLE backup_checkpoints (
    id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    actor_id uuid REFERENCES users (id),
    label varchar(120),
    manifest jsonb NOT NULL,
    manifest_hash char(64) NOT NULL
);

CREATE INDEX backup_checkpoints_created_idx ON backup_checkpoints (created_at DESC);

-- Archive manifests bind a generated PDF export to a retention period.
CREATE TABLE archive_manifests (
    id uuid PRIMARY KEY,
    export_job_id uuid NOT NULL UNIQUE REFERENCES export_jobs (id),
    journal_id uuid NOT NULL REFERENCES journals (id),
    period_from timestamptz NOT NULL,
    period_to timestamptz NOT NULL,
    entries_count integer NOT NULL CHECK (entries_count >= 0),
    pdf_sha256 char(64) NOT NULL,
    csv_sha256 char(64) NOT NULL,
    manifest jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT archive_manifests_period CHECK (period_from < period_to)
);

CREATE INDEX archive_manifests_journal_idx ON archive_manifests (journal_id, period_to DESC);

-- WORM: a completed export and its archive manifest cannot be modified or
-- deleted. The only allowed update is the queued -> done generation step.
CREATE FUNCTION export_jobs_worm_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
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

CREATE TRIGGER export_jobs_worm_guard_trg
    BEFORE UPDATE OR DELETE ON export_jobs
    FOR EACH ROW EXECUTE FUNCTION export_jobs_worm_guard();

CREATE FUNCTION archive_manifests_worm_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'WORM: archive manifest cannot be modified or deleted';
END;
$$;

CREATE TRIGGER archive_manifests_worm_guard_trg
    BEFORE UPDATE OR DELETE ON archive_manifests
    FOR EACH ROW EXECUTE FUNCTION archive_manifests_worm_guard();

-- Retention: a journal entry cannot be physically deleted before 3 years from
-- its business time. Soft delete (status='deleted') remains allowed; the legal
-- log keeps history and is exported/archived instead.
CREATE FUNCTION journal_entries_retention_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.performed_at > now() - interval '3 years' THEN
        RAISE EXCEPTION
            'retention: entry % is protected until %',
            OLD.id, OLD.performed_at + interval '3 years';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER journal_entries_retention_guard_trg
    BEFORE DELETE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION journal_entries_retention_guard();

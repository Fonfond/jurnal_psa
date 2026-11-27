-- 0004: sync change log, idempotency, audit, exports

CREATE TABLE change_log (
    seq bigserial PRIMARY KEY,
    entity_type varchar(32) NOT NULL,
    entity_id uuid NOT NULL,
    op varchar(16) NOT NULL CHECK (op IN ('upsert', 'delete')),
    version integer,
    changed_at timestamptz NOT NULL DEFAULT now(),
    actor_id uuid REFERENCES users (id)
);

CREATE INDEX change_log_entity_idx ON change_log (entity_type, entity_id);
CREATE INDEX change_log_changed_at_idx ON change_log (changed_at);

CREATE TABLE idempotency_records (
    op_id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id),
    device_id uuid REFERENCES devices (id),
    response jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idempotency_created_idx ON idempotency_records (created_at);

CREATE TABLE audit_events (
    id uuid PRIMARY KEY,
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    actor_id uuid NOT NULL REFERENCES users (id),
    actor_role user_role_enum NOT NULL,
    action varchar(40) NOT NULL,
    entity_type varchar(32) NOT NULL,
    entity_id uuid,
    before jsonb,
    after jsonb,
    reason varchar(200),
    source varchar(16) NOT NULL CHECK (source IN ('client', 'server')),
    device_id uuid REFERENCES devices (id),
    ip inet,
    user_agent varchar(300),
    request_id varchar(64),
    app_version varchar(20),
    stream varchar(40) NOT NULL,
    stream_seq bigint NOT NULL,
    prev_hash char(64) NOT NULL,
    hash char(64) NOT NULL,
    CONSTRAINT audit_stream_unique UNIQUE (stream, stream_seq)
);

CREATE INDEX audit_actor_idx ON audit_events (actor_id, occurred_at DESC);
CREATE INDEX audit_entity_idx ON audit_events (entity_type, entity_id);

CREATE TABLE export_jobs (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id),
    type varchar(20) NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'queued',
    file_url varchar(512),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz
);

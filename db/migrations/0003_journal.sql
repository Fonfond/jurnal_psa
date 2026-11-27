-- 0003: journal entries, revisions, workers, conflicts

CREATE TYPE entry_status_enum AS ENUM ('active', 'deleted');
CREATE TYPE binding_status_enum AS ENUM ('linked', 'unresolved', 'not_found', 'not_required');
CREATE TYPE input_method_enum AS ENUM ('voice', 'manual');
CREATE TYPE asr_engine_enum AS ENUM ('on_device', 'web_speech');
CREATE TYPE revision_source_enum AS ENUM ('client', 'server', 'conflict_resolution');
CREATE TYPE conflict_resolution_enum AS ENUM ('local', 'remote', 'manual', 'pending');

CREATE TABLE journal_entries (
    id uuid PRIMARY KEY,
    author_id uuid NOT NULL REFERENCES users (id),
    performed_at timestamptz NOT NULL,
    performed_tz_offset_min integer NOT NULL CHECK (performed_tz_offset_min BETWEEN -840 AND 840),
    performed_at_source performed_source_enum NOT NULL,
    performed_at_reason_id uuid REFERENCES correction_reasons (id),
    performed_at_comment varchar(200),
    shift_date date,
    work_type_id uuid NOT NULL REFERENCES work_types (id),
    site_id uuid REFERENCES sites (id),
    permit_id uuid REFERENCES permits (id),
    permit_number_raw varchar(32),
    permit_binding_status binding_status_enum NOT NULL DEFAULT 'not_required',
    permit_status_at_sync permit_status_enum,
    permit_risk_flag boolean NOT NULL DEFAULT false,
    permit_risk_reason varchar(200),
    "text" text NOT NULL,
    comment varchar(500),
    input_method input_method_enum NOT NULL,
    asr_engine asr_engine_enum,
    asr_confidence numeric(4, 3),
    offline_created boolean NOT NULL DEFAULT false,
    status entry_status_enum NOT NULL DEFAULT 'active',
    version integer NOT NULL DEFAULT 1,
    hlc varchar(32) NOT NULL,
    created_at_client timestamptz NOT NULL,
    created_at_server timestamptz NOT NULL DEFAULT now(),
    updated_at_client timestamptz NOT NULL,
    updated_at_server timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by uuid REFERENCES users (id),
    delete_reason_id uuid REFERENCES correction_reasons (id),
    device_id uuid REFERENCES devices (id),
    revision_no integer NOT NULL DEFAULT 0,
    last_op_id uuid,
    verified_at timestamptz,
    verified_by uuid REFERENCES users (id),
    unverified_at timestamptz,
    unverified_by uuid REFERENCES users (id),
    CONSTRAINT journal_text_length CHECK (char_length(btrim("text")) BETWEEN 10 AND 2000),
    CONSTRAINT journal_text_not_blank CHECK (btrim("text") <> ''),
    CONSTRAINT journal_voice_engine CHECK (input_method <> 'voice' OR asr_engine IS NOT NULL),
    CONSTRAINT journal_risk_reason CHECK (permit_risk_flag = false OR permit_risk_reason IS NOT NULL),
    CONSTRAINT journal_permit_exclusive CHECK (permit_id IS NULL OR permit_number_raw IS NULL),
    CONSTRAINT journal_link_requires_permit CHECK (permit_binding_status <> 'linked' OR permit_id IS NOT NULL)
);

CREATE INDEX journal_author_performed_idx ON journal_entries (author_id, performed_at DESC);
CREATE INDEX journal_permit_idx ON journal_entries (permit_id);
CREATE INDEX journal_status_idx ON journal_entries (status);
CREATE INDEX journal_performed_idx ON journal_entries (performed_at);

CREATE TABLE entry_revisions (
    id uuid PRIMARY KEY,
    entry_id uuid NOT NULL REFERENCES journal_entries (id),
    revision_no integer NOT NULL,
    changed_by uuid NOT NULL REFERENCES users (id),
    changed_at timestamptz NOT NULL,
    source revision_source_enum NOT NULL,
    hlc varchar(32) NOT NULL,
    base_version integer NOT NULL,
    result_version integer NOT NULL,
    diff jsonb NOT NULL DEFAULT '{}'::jsonb,
    reason_id uuid REFERENCES correction_reasons (id),
    reason_comment varchar(200),
    CONSTRAINT entry_revisions_unique_no UNIQUE (entry_id, revision_no)
);

CREATE TABLE entry_workers (
    entry_id uuid NOT NULL REFERENCES journal_entries (id),
    user_id uuid NOT NULL REFERENCES users (id),
    PRIMARY KEY (entry_id, user_id)
);

CREATE TABLE attachments (
    id uuid PRIMARY KEY,
    entry_id uuid NOT NULL REFERENCES journal_entries (id),
    kind varchar(20) NOT NULL,
    mime varchar(100) NOT NULL,
    size_bytes integer NOT NULL,
    sha256 char(64) NOT NULL,
    width integer,
    height integer,
    status varchar(20) NOT NULL DEFAULT 'local',
    remote_url varchar(512),
    created_at timestamptz NOT NULL DEFAULT now(),
    uploaded_at timestamptz
);

CREATE TABLE conflict_records (
    id uuid PRIMARY KEY,
    entry_id uuid NOT NULL REFERENCES journal_entries (id),
    field varchar(40) NOT NULL,
    local_value jsonb,
    remote_value jsonb,
    local_hlc varchar(32) NOT NULL,
    remote_hlc varchar(32) NOT NULL,
    resolution conflict_resolution_enum NOT NULL DEFAULT 'pending',
    resolved_by uuid REFERENCES users (id),
    resolved_at timestamptz
);

CREATE INDEX conflict_entry_idx ON conflict_records (entry_id, resolution);

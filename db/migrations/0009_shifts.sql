-- 0009: shift handover (JRN-02) — first-class shifts with two-sided acceptance.
-- Additive: independent of journal entries; entries are referenced by a hash
-- snapshot at handover time.

ALTER TYPE signature_entity_type_enum ADD VALUE IF NOT EXISTS 'shift';

CREATE TYPE shift_status_enum AS ENUM ('handed_over', 'accepted', 'rejected', 'cancelled');

CREATE TABLE shifts (
    id uuid PRIMARY KEY,
    journal_id uuid NOT NULL REFERENCES journals (id),
    shift_date date NOT NULL,
    period_start timestamptz NOT NULL,
    period_end timestamptz NOT NULL,
    status shift_status_enum NOT NULL DEFAULT 'handed_over',
    handed_over_by uuid NOT NULL REFERENCES users (id),
    handed_over_at timestamptz NOT NULL,
    handover_comment varchar(1000) NOT NULL,
    accepted_by uuid REFERENCES users (id),
    accepted_at timestamptz,
    acceptance_comment varchar(1000),
    rejected_by uuid REFERENCES users (id),
    rejected_at timestamptz,
    rejection_reason varchar(500),
    entries_count integer NOT NULL DEFAULT 0 CHECK (entries_count >= 0),
    entries_hash char(64) NOT NULL,
    content_hash char(64) NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    hlc varchar(32) NOT NULL,
    field_clocks jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at_client timestamptz NOT NULL,
    created_at_server timestamptz NOT NULL DEFAULT now(),
    updated_at_client timestamptz NOT NULL,
    updated_at_server timestamptz NOT NULL DEFAULT now(),
    device_id uuid REFERENCES devices (id),
    last_op_id uuid,
    CONSTRAINT shifts_period_check CHECK (period_start < period_end),
    CONSTRAINT shifts_handover_comment CHECK (char_length(btrim(handover_comment)) BETWEEN 5 AND 1000),
    CONSTRAINT shifts_two_sides CHECK (accepted_by IS NULL OR accepted_by <> handed_over_by),
    CONSTRAINT shifts_accepted_fields CHECK (
        status <> 'accepted' OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL)
    ),
    CONSTRAINT shifts_rejected_fields CHECK (
        status <> 'rejected' OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL)
    )
);

CREATE INDEX shifts_journal_date_idx ON shifts (journal_id, shift_date DESC);
CREATE INDEX shifts_status_idx ON shifts (status);
CREATE INDEX shifts_handed_idx ON shifts (handed_over_by, handed_over_at DESC);
CREATE INDEX shifts_accepted_idx ON shifts (accepted_by, accepted_at DESC);

-- Only one open/accepted shift per journal and period start: re-handover after
-- rejection is allowed, duplicate handovers are not.
CREATE UNIQUE INDEX shifts_active_window_uq
    ON shifts (journal_id, shift_date, period_start)
    WHERE status IN ('handed_over', 'accepted');

-- Audit and change-log streams already exist; this migration only adds the
-- entity. `change_log.entity_type` is varchar, no enum change is required.

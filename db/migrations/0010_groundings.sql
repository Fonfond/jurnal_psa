-- 0010: grounding registry (JRN-06) — first-class state of portable grounding
-- and grounding knives, derived from `grounding` journal events.

CREATE TYPE grounding_state_enum AS ENUM ('applied', 'removed');
CREATE TYPE grounding_type_enum AS ENUM ('portable', 'fixed');

CREATE TABLE groundings (
    id uuid PRIMARY KEY,
    journal_id uuid NOT NULL REFERENCES journals (id),
    site_id uuid REFERENCES sites (id),
    point varchar(200) NOT NULL,
    grounding_type grounding_type_enum NOT NULL,
    tool_number varchar(64),
    count integer NOT NULL DEFAULT 1 CHECK (count BETWEEN 1 AND 100),
    state grounding_state_enum NOT NULL DEFAULT 'applied',
    applied_entry_id uuid REFERENCES journal_entries (id),
    applied_by uuid REFERENCES users (id),
    applied_at timestamptz,
    removed_entry_id uuid REFERENCES journal_entries (id),
    removed_by uuid REFERENCES users (id),
    removed_at timestamptz,
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at_server timestamptz NOT NULL DEFAULT now(),
    updated_at_server timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT groundings_applied_fields CHECK (
        state <> 'applied'
        OR (applied_entry_id IS NOT NULL AND applied_at IS NOT NULL)
    ),
    CONSTRAINT groundings_removed_fields CHECK (
        state <> 'removed'
        OR (removed_entry_id IS NOT NULL AND removed_at IS NOT NULL)
    )
);

-- One active grounding per journal/site/point/type/tool. A removed row keeps
-- history; a repeated "applied" for an active point is a conflict.
CREATE UNIQUE INDEX groundings_active_uq
    ON groundings (
        journal_id,
        coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
        point,
        grounding_type,
        coalesce(tool_number, '')
    )
    WHERE state = 'applied';

CREATE INDEX groundings_journal_idx ON groundings (journal_id, state);
CREATE INDEX groundings_site_idx ON groundings (site_id, state);
CREATE INDEX groundings_point_idx ON groundings (point);

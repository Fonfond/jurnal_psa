-- 0002: permits and dictionaries

CREATE TYPE permit_status_enum AS ENUM ('draft', 'active', 'suspended', 'closed', 'annulled');
CREATE TYPE permit_type_enum AS ENUM ('permit_to_work', 'order', 'other');
CREATE TYPE correction_applies_to_enum AS ENUM ('performed_at', 'delete', 'edit');

CREATE TABLE sites (
    id uuid PRIMARY KEY,
    code varchar(32) NOT NULL UNIQUE,
    name varchar(120) NOT NULL,
    parent_id uuid REFERENCES sites (id),
    active boolean NOT NULL DEFAULT true,
    version integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE templates (
    id uuid PRIMARY KEY,
    work_type_id uuid NOT NULL,
    text varchar(500) NOT NULL,
    tags text[] NOT NULL DEFAULT '{}',
    active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0,
    version integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE work_types (
    id uuid PRIMARY KEY,
    code varchar(32) NOT NULL UNIQUE,
    name varchar(120) NOT NULL,
    requires_permit boolean NOT NULL DEFAULT false,
    requires_site boolean NOT NULL DEFAULT true,
    default_template_id uuid REFERENCES templates (id),
    active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0,
    version integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE templates
    ADD CONSTRAINT templates_work_type_fk FOREIGN KEY (work_type_id) REFERENCES work_types (id);

CREATE TABLE correction_reasons (
    id uuid PRIMARY KEY,
    code varchar(32) NOT NULL UNIQUE,
    name varchar(120) NOT NULL,
    applies_to correction_applies_to_enum NOT NULL,
    active boolean NOT NULL DEFAULT true
);

CREATE TABLE permits (
    id uuid PRIMARY KEY,
    source_id varchar(32) NOT NULL,
    external_id varchar(64) NOT NULL,
    number varchar(32) NOT NULL,
    number_norm varchar(32) NOT NULL,
    year integer NOT NULL,
    type permit_type_enum NOT NULL DEFAULT 'permit_to_work',
    status permit_status_enum NOT NULL DEFAULT 'draft',
    valid_from timestamptz NOT NULL,
    valid_to timestamptz NOT NULL,
    site_id uuid NOT NULL REFERENCES sites (id),
    work_description varchar(2000) NOT NULL,
    responsible_user_id uuid NOT NULL REFERENCES users (id),
    external_url varchar(512),
    pdf_url varchar(512),
    pdf_hash varchar(64),
    pdf_size_bytes integer,
    updated_at_external timestamptz NOT NULL,
    synced_at timestamptz,
    version integer NOT NULL DEFAULT 1,
    is_deleted boolean NOT NULL DEFAULT false,
    CONSTRAINT permits_source_external_unique UNIQUE (source_id, external_id),
    CONSTRAINT permits_number_unique UNIQUE (source_id, year, number_norm),
    CONSTRAINT permits_valid_range CHECK (valid_from <= valid_to)
);

CREATE TABLE permit_participants (
    permit_id uuid NOT NULL REFERENCES permits (id),
    user_id uuid NOT NULL REFERENCES users (id),
    role_in_permit varchar(32) NOT NULL,
    acknowledged_at timestamptz,
    PRIMARY KEY (permit_id, user_id)
);

CREATE INDEX permits_status_idx ON permits (status, valid_to);
CREATE INDEX permits_site_idx ON permits (site_id);

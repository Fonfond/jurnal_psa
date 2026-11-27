-- 0001: identity, departments, sessions, devices, dictionaries versioning

CREATE TYPE user_role_enum AS ENUM ('worker', 'supervisor', 'admin', 'auditor');
CREATE TYPE user_status_enum AS ENUM ('active', 'blocked', 'deactivated');
CREATE TYPE device_status_enum AS ENUM ('active', 'revoked');
CREATE TYPE performed_source_enum AS ENUM ('device_auto', 'manual', 'server_corrected');

CREATE TABLE departments (
    id uuid PRIMARY KEY,
    code varchar(32) NOT NULL UNIQUE,
    name varchar(120) NOT NULL,
    parent_id uuid REFERENCES departments (id),
    active boolean NOT NULL DEFAULT true,
    version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id uuid PRIMARY KEY,
    external_id varchar(64) NOT NULL UNIQUE,
    full_name varchar(200) NOT NULL,
    personnel_no varchar(32) UNIQUE,
    email varchar(120) UNIQUE,
    phone varchar(20),
    role user_role_enum NOT NULL,
    department_id uuid NOT NULL REFERENCES departments (id),
    position varchar(120),
    status user_status_enum NOT NULL DEFAULT 'active',
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1
);

CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id),
    token_hash char(64) NOT NULL UNIQUE,
    user_agent varchar(300),
    ip inet,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);

CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE devices (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id),
    name varchar(80),
    platform varchar(40),
    app_version varchar(20),
    user_agent varchar(300),
    push_subscription jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    status device_status_enum NOT NULL DEFAULT 'active'
);

CREATE INDEX devices_user_idx ON devices (user_id);

CREATE TABLE dictionary_versions (
    name varchar(40) PRIMARY KEY,
    version integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dev-only credentials for ADR-22 (OIDC replaces this in production).
CREATE TABLE user_credentials (
    user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    password_hash text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

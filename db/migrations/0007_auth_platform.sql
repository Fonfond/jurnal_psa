-- 0007: auth platform — OIDC/PKCE, device registration, signature abstraction.
-- Additive only: dev login and existing seed devices keep working.

-- IdP identities (OIDC issuer + subject) linked to provisioned users.
CREATE TABLE user_identities (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider varchar(32) NOT NULL DEFAULT 'oidc',
    issuer varchar(255) NOT NULL,
    subject varchar(255) NOT NULL,
    email varchar(255),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz,
    UNIQUE (issuer, subject)
);

CREATE INDEX user_identities_user_idx ON user_identities (user_id);

-- Short-lived OIDC login transaction: state/nonce/PKCE verifier + redirect target.
CREATE TABLE oidc_login_requests (
    id uuid PRIMARY KEY,
    state_hash char(64) NOT NULL UNIQUE,
    nonce varchar(128) NOT NULL,
    code_verifier varchar(128) NOT NULL,
    code_challenge varchar(128) NOT NULL,
    redirect_after varchar(512),
    device_id uuid REFERENCES devices (id) ON DELETE SET NULL,
    user_agent varchar(300),
    ip inet,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
);

CREATE INDEX oidc_login_requests_expires_idx ON oidc_login_requests (expires_at);

-- Device registration (ADR-23): stable install id per user, optional key binding.
ALTER TABLE devices
    ADD COLUMN install_id varchar(128),
    ADD COLUMN fingerprint varchar(128),
    ADD COLUMN device_key_hash char(64),
    ADD COLUMN registered_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN revoked_at timestamptz;

CREATE UNIQUE INDEX devices_user_install_uq
    ON devices (user_id, install_id)
    WHERE install_id IS NOT NULL;

-- Sessions may be bound to a device so device revocation kills its sessions.
ALTER TABLE sessions
    ADD COLUMN device_id uuid REFERENCES devices (id) ON DELETE SET NULL;

CREATE INDEX sessions_device_idx ON sessions (device_id);

-- Electronic signature abstraction (OQ-04): simple (server HMAC) or qualified
-- (external КЭП adapter). No legal status is claimed until OQ-04 is closed.
CREATE TYPE signature_kind_enum AS ENUM ('simple', 'qualified');
CREATE TYPE signature_status_enum AS ENUM ('valid', 'invalid', 'revoked');
CREATE TYPE signature_entity_type_enum AS ENUM ('journal_review', 'entry');

CREATE TABLE document_signatures (
    id uuid PRIMARY KEY,
    entity_type signature_entity_type_enum NOT NULL,
    entity_id uuid NOT NULL,
    entity_version integer NOT NULL DEFAULT 0,
    content_hash char(64) NOT NULL,
    kind signature_kind_enum NOT NULL,
    algorithm varchar(32) NOT NULL,
    signature_value text NOT NULL,
    key_id varchar(128),
    certificate_serial varchar(128),
    certificate_subject varchar(512),
    signer_id uuid NOT NULL REFERENCES users (id),
    signed_at timestamptz NOT NULL DEFAULT now(),
    status signature_status_enum NOT NULL DEFAULT 'valid',
    metadata jsonb,
    UNIQUE (entity_type, entity_id, entity_version, kind)
);

CREATE INDEX document_signatures_entity_idx
    ON document_signatures (entity_type, entity_id);
CREATE INDEX document_signatures_signer_idx
    ON document_signatures (signer_id, signed_at DESC);

-- Secure remote-agent enrollment and authorization (BRAP v1).
--
-- Enrollment bearer secrets are never stored: token_hash is SHA-256(secret).
-- All lookups are scoped through the host-resolved community_id. Redemption
-- holds the enrollment row FOR UPDATE so only one worker can consume a token,
-- even when several relay processes receive the token concurrently.
--
-- A worker is authorized only while approved_at IS NOT NULL and revoked_at IS
-- NULL. The partial unique index prevents a worker identity from being bound
-- to two active deployments in one community. Revocation is durable and never
-- undone by reusing an enrollment token.
CREATE TABLE remote_agent_enrollments (
    community_id       UUID        NOT NULL REFERENCES communities(id),
    id                 UUID        NOT NULL DEFAULT gen_random_uuid(),
    token_hash         BYTEA       NOT NULL CHECK (length(token_hash) = 32),
    owner_pubkey       TEXT        NOT NULL CHECK (owner_pubkey ~ '^[0-9a-f]{64}$'),
    capabilities       JSONB       NOT NULL,
    expires_at         TIMESTAMPTZ NOT NULL,
    used_at            TIMESTAMPTZ,
    worker_pubkey      TEXT        CHECK (
        worker_pubkey IS NULL OR worker_pubkey ~ '^[0-9a-f]{64}$'
    ),
    enrollment_event_id BYTEA      CHECK (
        enrollment_event_id IS NULL OR length(enrollment_event_id) = 32
    ),
    approval_event_id  BYTEA       CHECK (
        approval_event_id IS NULL OR length(approval_event_id) = 32
    ),
    approved_at        TIMESTAMPTZ,
    revoked_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, id),
    UNIQUE (community_id, token_hash),
    CHECK (jsonb_typeof(capabilities) = 'array'),
    CHECK (
        (used_at IS NULL AND worker_pubkey IS NULL AND enrollment_event_id IS NULL)
        OR
        (used_at IS NOT NULL AND worker_pubkey IS NOT NULL AND enrollment_event_id IS NOT NULL)
    ),
    CHECK (approved_at IS NULL OR used_at IS NOT NULL),
    CHECK (revoked_at IS NULL OR used_at IS NOT NULL)
);

CREATE UNIQUE INDEX remote_agent_active_worker_idx
    ON remote_agent_enrollments (community_id, worker_pubkey)
    WHERE worker_pubkey IS NOT NULL AND revoked_at IS NULL;

CREATE INDEX remote_agent_owner_idx
    ON remote_agent_enrollments (community_id, owner_pubkey, created_at DESC);

CREATE INDEX remote_agent_expiry_idx
    ON remote_agent_enrollments (expires_at)
    WHERE used_at IS NULL;

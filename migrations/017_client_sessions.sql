-- Migration 017: client_sessions, the web client's browser sessions (story
-- s-client-channel-m1, ADR-076).
--
-- A client logs in with the access code held in the secret store and gets a
-- random session token in an HttpOnly cookie. Only the token's SHA-256 is stored,
-- so a read of this table cannot be replayed as a cookie. Sessions live here, not
-- in process memory, so a restart neither logs every client out nor forgets a
-- revocation (Discipline B).

CREATE TABLE client_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT client_sessions_expiry_after_creation CHECK (expires_at > created_at)
);

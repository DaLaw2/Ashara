-- Migration 012: secret store (ADR-073 Q10, ADR-075 S1).
--
-- Secret values are stored only as AES-256-GCM ciphertext; the master key lives
-- in a file outside the database, so a dump of this table alone reveals nothing.
-- `key_id` is a fingerprint of the key that encrypted the row, so a key rotation
-- can find the rows still under the old key. Additive: no existing table is touched.

CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  iv BYTEA NOT NULL,
  ciphertext BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

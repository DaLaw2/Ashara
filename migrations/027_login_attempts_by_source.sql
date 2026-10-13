-- Migration 027: login throttle keyed by source address (task t-login-hardening,
-- story s-client-channel-m1).
--
-- Before this migration the throttle counted failures by client name alone, so
-- five wrong guesses from anyone locked the real client out. Each row now also
-- carries the source the attempt came from (an IPv4 address or an IPv6 /64), and
-- the throttle caps the (name, source) pair and the source, never a count across
-- sources.
--
-- A row is written BEFORE the code is compared (the reservation that makes the
-- cap atomic) and deleted again when the login succeeds, so a row is a failed or
-- an in-flight attempt.
--
-- Existing rows carry no address and none can be recovered; they are at most one
-- window old and only throttle evidence, so they are dropped rather than given
-- an invented address. The cost is that a throttle in force at migration time
-- is lifted once.

DELETE FROM client_login_failures;

ALTER TABLE client_login_failures
  ADD COLUMN source_address TEXT NOT NULL CHECK (length(source_address) > 0);

CREATE INDEX idx_client_login_failures_name_source_time
  ON client_login_failures (client_name, source_address, failed_at);
CREATE INDEX idx_client_login_failures_source_time ON client_login_failures (source_address, failed_at);
CREATE INDEX idx_client_login_failures_time ON client_login_failures (failed_at);

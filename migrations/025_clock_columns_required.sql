-- A session's creation and a login failure's time are written from the injected clock, the one the
-- session's expiry and the throttle's window are judged on; a database default would let an insert
-- that omits them take the database's clock instead, so each must be supplied.

ALTER TABLE public.client_sessions ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE public.client_login_failures ALTER COLUMN failed_at DROP DEFAULT;

-- A step fault's last update is written from the injected clock, the one its backoff is judged on;
-- a database default would let an insert that omits it take the database's clock instead.

ALTER TABLE public.step_faults ALTER COLUMN updated_at DROP DEFAULT;

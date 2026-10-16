-- Migration 065: a passed acceptance sweep records the stored checks it ran and saw pass.
--
-- acceptance_sweeps.executed_checks: a JSON array of {taskId, name, command}, one per stored check
-- the sweep ran on main that passed, in the order run. The delivered report presents these commands,
-- and only these, as ways of running the product that acceptance verified: the public interface file
-- is compared with the product scaffold's bytes and none of its entries is run, so a file a later
-- task left stale is quoted as unverified. A row written before this migration has none: NULL, which
-- is no evidence that anything ran, and the report says what ran is not on record.

ALTER TABLE acceptance_sweeps
  ADD COLUMN executed_checks jsonb CHECK (executed_checks IS NULL OR jsonb_typeof(executed_checks) = 'array');

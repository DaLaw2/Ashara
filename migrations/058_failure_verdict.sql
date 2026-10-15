-- Migration 058: Quality's verdict on a Failed work item's last attempt is stored with the Failed
-- transition (G4 across a restart; ADR-080 d5). A Failed item parked by a dead process, or by a
-- routing an orchestrator error interrupted, is routed later by the startup reconciler or by the
-- loop's error recovery: it is routed by this stored verdict, so a non-retryable failure is given
-- up and never replanned.
--
-- The value is Quality's FailureVerdict as jsonb ({"kind": "retryable" | "non-retryable",
-- "ground": ...}), read back through Zod. The work item repository's save, the one writer of a
-- status, writes it on every entry into Failed (a verdict is required there) and clears it on every
-- exit from Failed. NULL on a Failed row means the row failed before this migration: no verdict
-- was kept for it, and it is routed as retryable work within the replan bound.

ALTER TABLE work_items ADD COLUMN failure_verdict jsonb;

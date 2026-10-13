-- Migration 010: Retire the run-end sweep's persisted traces.
--
-- t-cut-w7 deleted run termination, the run-end sweep (shutdown-reconciler),
-- the startup Pending-orphan pass and closeRun. Their blocked_reason sources
-- 'shutdown-reconciler' and 'startup-reconciler' are no longer variants of
-- StoredBlockedReason, so a surviving row would fail parseStoredBlockedReason
-- on read. Rewrite them to 'orchestrator_error' (same required `reason` field)
-- and drop the variant-only keys.
--
-- RunState lost `closed`: nothing closes a run any more, so the spend is a
-- lifetime total per database (ADR-073 addendum 3). A record that was closed
-- held a finished run's spend, which the old protocol would have discarded at
-- the next start; delete it so the new protocol does not resurrect it.
--
-- task_spec lost the acceptance-gap keys (lesson, suggestedApproach,
-- supersedes) and artifactContext. The schema strips unknown keys on read, so
-- this strip is hygiene, not a correctness requirement.

UPDATE work_items
SET blocked_reason = jsonb_set(
  blocked_reason - 'previousStatus' - 'previousScope',
  '{source}',
  '"orchestrator_error"'
)
WHERE blocked_reason->>'source' IN ('shutdown-reconciler', 'startup-reconciler');

DELETE FROM system_settings
WHERE key = 'orchestrator.run_state'
  AND (value::jsonb->>'closed') = 'true';

UPDATE work_items
SET task_spec = task_spec - 'lesson' - 'suggestedApproach' - 'supersedes' - 'artifactContext'
WHERE task_spec ?| ARRAY['lesson', 'suggestedApproach', 'supersedes', 'artifactContext'];

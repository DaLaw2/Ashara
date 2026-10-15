-- Migration 057: The blocked_reason source of a task given up after its failed attempts is
-- 'failure_given_up' (G4): Delivery routes a failure by Quality's verdict on it, and the source
-- names what happened to the task, not the component that decided it. Every field of the variant
-- is kept; only the source and a fail-closed routing's reason text are rewritten, as migration 005
-- rewrote 'split_on_failure'.
--
-- Migration 048's plan_repair_on_abandon trigger opens a repair for every abandoned Task whose
-- source is not 'superseded', so the rename changes no repair. The rows rewritten here are already
-- Abandoned, and an UPDATE that leaves the status Abandoned does not fire it.

UPDATE work_items
  SET blocked_reason = jsonb_set(blocked_reason, '{source}', '"failure_given_up"')
  WHERE blocked_reason->>'source' = 'failure_router';

UPDATE work_items
  SET blocked_reason = jsonb_set(blocked_reason, '{reason}', '"routing_fault"')
  WHERE blocked_reason->>'source' = 'failure_given_up' AND blocked_reason->>'reason' = 'failure_router_error';

-- Migration 041: a task's merge record is the merge commit Z0 made on the target's main
-- (story s-independent-verify-m1, task t-stop-report-from-merge-record).
--
-- What the client is told was merged came from dev_sessions.phase = 'Completed', an attempt
-- log whose terminal write is fail-soft (a failed write is only logged), and which no part of
-- the merge writes. work_items.merge_commit is written by the orchestrator from the commit
-- Z0's merge step read back with `git rev-parse HEAD` right after `git commit` on main, and
-- before the task is moved to Completed: a failed write leaves the task not Completed.
--
-- No backfill: no row before this migration recorded which commit merged it, and a commit is
-- not inferred. A task merged before 041 is therefore not reported as merged (an under-claim,
-- never an over-claim).

ALTER TABLE work_items
  ADD COLUMN merge_commit TEXT;

-- A git object id: SHA-1 (40 hex) or SHA-256 (64 hex).
ALTER TABLE work_items
  ADD CONSTRAINT work_items_merge_commit_shape CHECK (
    merge_commit IS NULL OR merge_commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
  );

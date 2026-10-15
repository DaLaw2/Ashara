-- Migration 060: records hold what was recorded, and a halt says what stopped the work.
--
-- failed_approaches: affected_area was written as the task's title in lower case and
-- approach_description as the fixed sentence "Task '<title>' attempted execution". No producer
-- records the area a failure touched or the approach the agent took, so both columns held text the
-- writer composed rather than a fact, and later briefs rendered the title as the "affected" area.
-- The title, the failure reason and the lesson stay; the two columns and the area's index go.
--
-- project_blocks.spend: on a budget_cap halt, the amounts the spend cap was judged on when it
-- stopped work, as Finance read them from llm_calls: {"capUsd", "spentUsd", "inFlightUsd",
-- "nextCallUsd"}, nextCallUsd null when no call was refused (recorded and in-flight spend had
-- reached the cap). A cap refuses a call whose worst case would cross it, so the recorded spend can
-- sit well below the cap; the client's report states these amounts rather than a limit "reached".
-- NULL on every other kind, and on a budget_cap halt recorded before this migration, whose report
-- says the amounts are not on record.

DROP INDEX IF EXISTS idx_failed_approaches_area;
ALTER TABLE failed_approaches DROP COLUMN affected_area;
ALTER TABLE failed_approaches DROP COLUMN approach_description;

ALTER TABLE project_blocks ADD COLUMN spend jsonb;
ALTER TABLE project_blocks ADD CONSTRAINT project_blocks_spend_only_budget_cap CHECK (spend IS NULL OR kind = 'budget_cap');

-- replan_stopped: a plan revision whose every attempt failed, the last because the planning model
-- gave no usable answer (its output never validated, or its provider failed the request). Recorded
-- as 'fault' before, which tells the client and the operator that Ashara's own machinery failed; a
-- revision exhausted by any other error still is. Existing rows keep the kind they were written with.
ALTER TABLE projects
  DROP CONSTRAINT projects_blocked_category_known,
  ADD CONSTRAINT projects_blocked_category_known CHECK (
    blocked_category IS NULL
    OR blocked_category IN ('budget_cap', 'configuration', 'fault', 'check_dispute', 'replan_bound', 'suite_review', 'plan_repair', 'infrastructure', 'replan_stopped')
  );

ALTER TABLE project_blocks
  DROP CONSTRAINT project_blocks_kind_check,
  ADD CONSTRAINT project_blocks_kind_check CHECK (
    kind IN ('budget_cap', 'configuration', 'fault', 'planning_stopped', 'check_dispute', 'replan_bound', 'suite_review', 'plan_repair', 'infrastructure', 'replan_stopped')
  );

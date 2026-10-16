-- Migration 061: drop columns nothing writes and nothing reads (story s-legacy-review-ddd-shape, task
-- t-ddd-fix-hygiene, folding t-dead-columns-drop).
--
-- dev_sessions.worker_id, .output and .findings: no insert or update sets them and no query selects
-- them; a session's attempt is recorded in its attempt_* columns (migration 046).
-- knowledge_entries.ingestion_time, .decision_data and .finding_data: no insert sets them and no
-- query selects them; an entry's time is event_time and created_at, its body content.
-- The schema definitions are deleted in the same change.

ALTER TABLE dev_sessions
  DROP COLUMN IF EXISTS worker_id,
  DROP COLUMN IF EXISTS output,
  DROP COLUMN IF EXISTS findings;

ALTER TABLE knowledge_entries
  DROP COLUMN IF EXISTS ingestion_time,
  DROP COLUMN IF EXISTS decision_data,
  DROP COLUMN IF EXISTS finding_data;

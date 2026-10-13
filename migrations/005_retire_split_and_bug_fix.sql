-- Migration 005: Retire the task-split and bug-fix attribution paths.
--
-- blocked_reason source 'split_on_failure' is no longer a variant of the stored
-- schema, so a row still carrying it would fail to parse (BlockedReasonCorrupt).
-- Its fields (reason, attempts, lastFailure, plus the shared augmentation fields)
-- are a subset of the 'failure_router' variant, which is what abandoned the item
-- in all but name. The source is rewritten; every other field is kept.
--
-- task_spec keys written only by those paths are dropped. The stored schema no
-- longer declares them, so a read would strip them anyway; removing them here
-- keeps the rows equal to what the code can see.

UPDATE work_items
  SET blocked_reason = jsonb_set(blocked_reason, '{source}', '"failure_router"')
  WHERE blocked_reason->>'source' = 'split_on_failure';

UPDATE work_items
  SET task_spec = task_spec
    - 'splitDepth' - 'splitFrom'
    - 'culpritTaskId' - 'culpritTitle' - 'failureDiagnostic' - 'implicatedFiles' - 'suggestedFix'
  WHERE task_spec ?| ARRAY[
    'splitDepth', 'splitFrom',
    'culpritTaskId', 'culpritTitle', 'failureDiagnostic', 'implicatedFiles', 'suggestedFix'
  ];

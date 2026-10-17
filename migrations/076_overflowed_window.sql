-- Migration 076: the largest context window an attempt of a task did not fit (t-context-overflow-routing).
--
-- work_items.overflowed_window_tokens: an attempt whose turn did not fit its model's window ends
-- context_budget_exceeded, which the same model meets again on every retry. Delivery raises this to
-- the window it overflowed (never lowers it) and dispatches the task next only on a catalog model
-- whose window is larger; with none, the task is given up (blocked_reason source
-- context_window_exceeded). NULL: no attempt of the task has overflowed a window. On a column, so
-- the floor survives a restart and every later routing of the task.

ALTER TABLE work_items ADD COLUMN overflowed_window_tokens INTEGER CHECK (overflowed_window_tokens > 0);

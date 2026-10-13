-- Migration 009: Narrow work_items.level to Epic | Task.
--
-- The Story tier is deleted (t-cut-w6): story-decomposer, the Story/Feature
-- levels and every reader of them are gone, and WorkItemLevel is now
-- "Epic" | "Task". The CHECK follows the type so the database rejects a level
-- the code can no longer parse. Not rewritten: a surviving Story or Feature row
-- fails the ADD CONSTRAINT below and aborts the migration rather than being
-- silently relabelled.

ALTER TABLE work_items DROP CONSTRAINT IF EXISTS work_items_level_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_level_check CHECK (level IN ('Epic', 'Task'));

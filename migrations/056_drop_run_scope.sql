-- Migration 056: drop work_items.run_scope (ADR-080 d3, reshape step R2; the G7 cut of c-project-record;
-- story s-legacy-review-ddd-shape, task t-ddd-r2-engagement-vision).
--
-- Every writer stored the constant 'ad-hoc' and nothing read the column beyond parsing it: a work
-- item belongs to its project (project_id, NOT NULL since migration 014), which is the only scope
-- Ashara reads. The code that wrote and parsed the column is deleted in the same change.

ALTER TABLE work_items DROP COLUMN IF EXISTS run_scope;

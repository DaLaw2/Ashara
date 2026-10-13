-- Migration 024: the target workspace path is a project fact
-- (story s-liaison-intake-m1, task t-delivery-never-writes-vision; ADR-075).
--
-- Delivery minted the workspace path and wrote it onto the project's current
-- vision row (vision_documents.project_path), so Delivery edited a record that
-- Engagement owns, and a new vision version arrived with no path, re-minting a
-- second workspace for the same project. The path moves to projects.workspace_path.
--
-- Backfill: each project takes the path of its highest-version vision that has
-- one. A NOTICE reports the count. Projects without such a vision stay NULL and
-- get a path minted on their first dispatch.
--
-- vision_documents.project_path is then dropped: its only reader and writer were
-- VisionRepository.getProjectPath / setProjectPath, deleted in the same change.

ALTER TABLE projects ADD COLUMN workspace_path TEXT;

DO $$
DECLARE
  backfilled INTEGER;
BEGIN
  UPDATE projects p
     SET workspace_path = v.project_path
    FROM (
      SELECT DISTINCT ON (project_id) project_id, project_path
        FROM vision_documents
       WHERE project_path IS NOT NULL
       ORDER BY project_id, version DESC
    ) v
   WHERE v.project_id = p.id;
  GET DIAGNOSTICS backfilled = ROW_COUNT;
  RAISE NOTICE 'migration 024 backfill: % project(s) took a workspace path from vision_documents', backfilled;
END
$$;

ALTER TABLE vision_documents DROP COLUMN project_path;

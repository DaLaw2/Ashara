-- Migration 014: projects table; vision_documents and work_items carry project_id
-- (story s-project-record-m1, architecture K3).
--
-- A tender creates one `projects` row. Its vision versions and its work items are
-- keyed by that row, so no reader has to fall back on "the latest vision in the
-- whole database". project_contracts.project_id now names the same key (it named
-- the root work item before); it gets no FK here because rows written under the
-- old meaning may still exist and this migration does not delete them.
--
-- Legacy rows: if vision_documents or work_items hold any row, ONE project named
-- 'pre-project legacy rows (2026-10-13)' is created and every such row is
-- backfilled with its id before the columns become NOT NULL. A NOTICE reports
-- the counts. On an empty database no project row is created.

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE vision_documents ADD COLUMN project_id UUID REFERENCES projects(id);
ALTER TABLE work_items ADD COLUMN project_id UUID REFERENCES projects(id);

DO $$
DECLARE
  legacy_visions INTEGER;
  legacy_items INTEGER;
  legacy_project UUID;
BEGIN
  SELECT count(*) INTO legacy_visions FROM vision_documents;
  SELECT count(*) INTO legacy_items FROM work_items;
  IF legacy_visions > 0 OR legacy_items > 0 THEN
    INSERT INTO projects (name) VALUES ('pre-project legacy rows (2026-10-13)')
      RETURNING id INTO legacy_project;
    UPDATE vision_documents SET project_id = legacy_project;
    UPDATE work_items SET project_id = legacy_project;
  END IF;
  RAISE NOTICE 'migration 014 backfill: % vision_documents row(s), % work_items row(s), legacy project %',
    legacy_visions, legacy_items, legacy_project;
END
$$;

ALTER TABLE vision_documents ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE work_items ALTER COLUMN project_id SET NOT NULL;

-- Vision version is per project; the unique constraint is the guard against two
-- racing writers computing the same next version.
-- No column default either: VisionRepository.create computes every version.
DROP INDEX IF EXISTS idx_vision_docs_version;
ALTER TABLE vision_documents ALTER COLUMN version DROP DEFAULT;
ALTER TABLE vision_documents
  ADD CONSTRAINT vision_documents_project_version_unique UNIQUE (project_id, version);

CREATE INDEX idx_work_items_project_id ON work_items(project_id);

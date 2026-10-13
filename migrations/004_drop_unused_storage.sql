-- Migration 004: Drop storage nothing reads or writes, and move provider base URLs
-- out of the server's startup seed.
--
-- file_changes: no repository, schema entry, or query references the table.
-- knowledge_entries.embedding: no code writes or reads the column; retrieval is
-- full-text (ts_rank). Its HNSW index and the pgvector extension exist only for it.
-- The extension is dropped only when no other column still uses the vector type:
-- a database carrying tables that no migration here created keeps it, rather than
-- having those tables altered by a migration that does not know them.
--
-- Provider base URLs: the server used to upsert them on every start. 002 seeds the
-- provider rows without base_url, and openai-compatible providers require one, so
-- the URLs move here. Only NULLs are filled: an operator-set URL is never reverted.

DROP INDEX IF EXISTS idx_knowledge_embedding;
ALTER TABLE knowledge_entries DROP COLUMN IF EXISTS embedding;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE t.typname = 'vector' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    DROP EXTENSION IF EXISTS vector;
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_file_changes_recent;
DROP INDEX IF EXISTS idx_file_changes_task;
DROP TABLE IF EXISTS file_changes;

UPDATE provider_configs SET base_url = 'https://api.deepseek.com/v1', updated_at = NOW()
  WHERE name = 'deepseek' AND base_url IS NULL;
UPDATE provider_configs SET base_url = 'https://api.mistral.ai/v1', updated_at = NOW()
  WHERE name = 'mistral' AND base_url IS NULL;
UPDATE provider_configs SET base_url = 'https://api.x.ai/v1', updated_at = NOW()
  WHERE name = 'xai' AND base_url IS NULL;

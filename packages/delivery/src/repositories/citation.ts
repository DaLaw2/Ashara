import { sql, type SQL } from "drizzle-orm";

/** Whether work item `w` cites one of `keys` (a text[] expression) among its task_spec's sources. */
export const citesAnyOf = (keys: SQL): SQL =>
  sql`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.task_spec->'sources') = 'array'
    THEN w.task_spec->'sources' ELSE '[]'::jsonb END) s WHERE s->>'id' = ANY(${keys}))`;

import { sql } from "drizzle-orm";

/**
 * The state the client sees of the `projects` row in scope, composed from the stored records
 * as the web client is shown it: 'blocked' while the project has an open block
 * episode, otherwise its lifecycle. Written here from the schema, not imported from the code
 * under test, so an oracle that reads it judges that code instead of restating it.
 */
export const projectState = sql.raw(
  `(CASE WHEN EXISTS (SELECT 1 FROM project_blocks ps_b WHERE ps_b.project_id = projects.id AND ` +
    `ps_b.ended_at IS NULL) ` +
    `THEN 'blocked' ELSE projects.lifecycle END)`,
);

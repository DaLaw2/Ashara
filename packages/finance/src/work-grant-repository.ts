import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ProjectId } from "@ashara/shared";
import { insertedRow, projects, type DbHandle } from "@ashara/db";
import { workGrants } from "@ashara/db/schema/finance";

/** One owner grant of model requests to a project, as asked for. */
interface WorkGrant {
  readonly projectId: ProjectId;
  /** How many model requests are added to the project's work budget: a positive integer. */
  readonly requests: number;
  readonly grantedBy: string;
  readonly reason: string;
}

/** A grant that names no project, or adds no positive whole number of requests, or carries no who or why. */
class WorkGrantInvalid extends Error {
  constructor(
    readonly grant: WorkGrant,
    readonly detail: string,
  ) {
    super(`cannot grant ${grant.requests} model request(s) to project ${grant.projectId}: ${detail}`);
    this.name = "WorkGrantInvalid";
  }
}

const GrantedRowSchema = z.object({ granted: z.coerce.number().int().positive() });

/**
 * The owner's grants of model requests: the only way a
 * project's work budget grows. Append-only: a grant is never taken back or edited.
 */
export class WorkGrantRepository {
  constructor(private readonly db: DbHandle) {}

  /** Records one grant; returns its id and the project's granted requests after it. */
  async grant(grant: WorkGrant): Promise<{ readonly grantId: string; readonly grantedRequests: number }> {
    if (!Number.isSafeInteger(grant.requests) || grant.requests <= 0) throw new WorkGrantInvalid(grant, "requests must be a positive integer");
    if (grant.grantedBy.trim() === "" || grant.reason.trim() === "") throw new WorkGrantInvalid(grant, "who grants it and why must both be stated");
    return this.db.transaction(async (tx) => {
      const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, grant.projectId)).for("update");
      if (!project) throw new WorkGrantInvalid(grant, "no such project");
      const rows = await tx
        .insert(workGrants)
        .values({ projectId: grant.projectId, requests: grant.requests, grantedBy: grant.grantedBy.trim(), reason: grant.reason.trim() })
        .returning({ id: workGrants.id });
      const { id } = insertedRow(rows, "work_grants", `grant model requests to project ${grant.projectId}`);
      const total = await tx.execute(sql`SELECT COALESCE(SUM(requests), 0)::int AS granted FROM work_grants WHERE project_id = ${grant.projectId}`);
      const { granted } = GrantedRowSchema.parse(total.rows[0]);
      return { grantId: id, grantedRequests: granted };
    });
  }
}

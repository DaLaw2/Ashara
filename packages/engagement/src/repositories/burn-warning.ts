import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { projects } from "@ashara/db";
import { workBurnWarnings } from "@ashara/db/schema/engagement";
import type { Database, DbHandle } from "@ashara/db";
import { currentPlanImplementationTasks, currentPlanRevision } from "@ashara/delivery/reads";
import { projectWork } from "@ashara/finance";
import { parseProjectId, readEach, type UnreadSubject } from "@ashara/shared";
import { noOpenStop, projectAtWork } from "../predicates.js";
import type { BurnWarning, ProjectBurn } from "../burn-warning.js";
import { insertOutboundReport } from "./client-message.js";

// The work ledger's early warnings: each project at work, read with its current plan revision, its
// revision's implementation tasks and the zones already reported for that revision, and with the
// requests it drew and its grants as Finance's work ledger reads them (projectWork); and the one
// transaction that records a zone with its report.

const count = z.coerce.number().int().nonnegative();
const ZoneSchema = z.enum(["yellow", "red"]);

const BurnRowSchema = z.object({
  projectId: z.string(),
  planRevision: z.coerce.number().int().positive(),
  plannedTasks: count,
  completedTasks: count,
  reported: z.array(ZoneSchema),
});

/** A project's burn row reads a completed count above its planned one: no figure of it can be stated. */
class ProjectBurnUnreadable extends Error {
  constructor(
    readonly projectId: string,
    readonly detail: string,
  ) {
    super(`the work burn of project ${projectId} does not read: ${detail}`);
    this.name = "ProjectBurnUnreadable";
  }
}

const ListedSchema = z.array(z.looseObject({ projectId: z.string() }));

/**
 * Every project at work whose client has no stop awaiting the Liaison, with its burn, in one
 * statement; each row is read on its own (readEach), so one that does not read is its UnreadSubject.
 * The current plan revision is 1 for the first plan, else the latest revision's number.
 */
export async function listProjectBurns(db: DbHandle): Promise<Array<ProjectBurn | UnreadSubject>> {
  const result = await db.execute(sql`
    SELECT listed.*,
           (SELECT COALESCE(jsonb_agg(b.zone ORDER BY b.zone), '[]'::jsonb) FROM work_burn_warnings b
             WHERE b.project_id = listed."projectId" AND b.plan_revision = listed."planRevision") AS reported
    FROM (
      SELECT projects.id AS "projectId", projects.created_at,
             ${currentPlanRevision(projects.id)} AS "planRevision",
             ${currentPlanImplementationTasks(projects.id, "planned")} AS "plannedTasks",
             ${currentPlanImplementationTasks(projects.id, "completed")} AS "completedTasks"
      FROM projects
      WHERE ${projectAtWork()} AND ${noOpenStop(projects.id)}
    ) listed
    ORDER BY listed.created_at, listed."projectId"`);
  return readEach(
    ListedSchema.parse(result.rows),
    (row) => ({ id: row.projectId, projectId: parseProjectId(row.projectId, "projects.id") }),
    async (raw): Promise<ProjectBurn> => {
      const row = BurnRowSchema.parse(raw);
      if (row.completedTasks > row.plannedTasks) {
        throw new ProjectBurnUnreadable(row.projectId, `${row.completedTasks} completed of ${row.plannedTasks} planned implementation tasks`);
      }
      const projectId = parseProjectId(row.projectId, "projects.id");
      const work = await projectWork(db, projectId);
      return { ...row, projectId, drawnRequests: work.drawn, grantedRequests: work.granted };
    },
  );
}

/**
 * Records the warning and posts its report to the client, in one transaction with the project's row
 * locked, so a retried or concurrent post tells the client once. A zone already recorded for the
 * revision, or yellow after red, gets nothing.
 */
export async function postBurnWarning(db: Database, warning: BurnWarning): Promise<"posted" | "already-posted"> {
  return db.transaction(async (tx) => {
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, warning.projectId)).for("update");
    const recorded = await tx
      .select({ zone: workBurnWarnings.zone })
      .from(workBurnWarnings)
      .where(and(eq(workBurnWarnings.projectId, warning.projectId), eq(workBurnWarnings.planRevision, warning.planRevision)));
    const zones = z.array(ZoneSchema).parse(recorded.map((row) => row.zone));
    if (zones.includes(warning.zone) || (warning.zone === "yellow" && zones.includes("red"))) return "already-posted";
    const reportId = await insertOutboundReport(tx, warning.projectId, warning.body, null, `post the ${warning.zone} burn warning to project ${warning.projectId}`);
    await tx.insert(workBurnWarnings).values({
      projectId: warning.projectId,
      planRevision: warning.planRevision,
      zone: warning.zone,
      ...warning.figures,
      reportId,
      operatorReport: warning.operatorText,
    });
    return "posted";
  });
}

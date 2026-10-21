import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { planRevisions, taskChecks, workBurnWarnings, workItems } from "@ashara/db";
import type { DbHandle } from "@ashara/db";
import type { BurnZone } from "@ashara/finance";
import type { ProjectId } from "@ashara/shared";
import { goalTaskSql, inCurrentPlan } from "@ashara/delivery/predicates";
import { WORK_ITEM_STATUSES, parseStoredTaskSpec } from "@ashara/delivery/work-item";
import { inLatestCheckRevision, StoredDecidesSchema } from "@ashara/quality/stored-checks";
import type { RiskRecords } from "../early-warning.js";
import { VisionUnreadable, readVisionVersion } from "../vision.js";
import { VisionRepository } from "./vision.js";

// What the register of guarantees at risk reads for one project: the vision version in force, the
// plan's delivering tasks with what each cites and whether it is done, what the project's stored
// checks decide, and the burn zone reported for the current plan revision.

const StatusSchema = z.enum(WORK_ITEM_STATUSES);
const ZoneSchema = z.enum(["yellow", "red"]);

/** A record the register reads does not parse. */
class RiskRecordUnreadable extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "RiskRecordUnreadable";
  }
}

function specOf(taskId: string, raw: unknown): ReturnType<typeof parseStoredTaskSpec> {
  try {
    return parseStoredTaskSpec(raw);
  } catch (err) {
    throw new RiskRecordUnreadable(`work item ${taskId}: its task_spec does not parse: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function delivering(db: DbHandle, projectId: ProjectId): Promise<Array<{ readonly id: string; readonly done: boolean; readonly cites: readonly string[] }>> {
  const rows = await db
    .select({ id: workItems.id, status: workItems.status, taskSpec: workItems.taskSpec })
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), goalTaskSql, inCurrentPlan(workItems)))
    .orderBy(asc(workItems.id));
  return rows.flatMap((row) => {
    const spec = specOf(row.id, row.taskSpec);
    if (spec === undefined) throw new RiskRecordUnreadable(`work item ${row.id}: a goal task that records no task_spec`);
    const status = StatusSchema.safeParse(row.status);
    if (!status.success) throw new RiskRecordUnreadable(`work item ${row.id}: status ${JSON.stringify(row.status)} is not a work item status`);
    if (spec.sources === undefined) throw new RiskRecordUnreadable(`work item ${row.id}: a decomposed task that records no cited vision items`);
    return [{ id: row.id, done: status.data === "Completed", cites: spec.sources.map((source) => source.id) }];
  });
}

/** The vision item ids decided by the latest stored revision of each given task's checks. */
async function decidedBy(db: DbHandle, taskIds: readonly string[]): Promise<string[]> {
  if (taskIds.length === 0) return [];
  const rows = await db
    .select({ taskId: taskChecks.taskId, name: taskChecks.name, decides: taskChecks.decides })
    .from(taskChecks)
    .where(
      and(
        inArray(taskChecks.taskId, [...taskIds]),
        inLatestCheckRevision(taskChecks.revision, taskChecks.taskId),
      ),
    );
  return rows.flatMap((row) => {
    const decides = StoredDecidesSchema.safeParse(row.decides);
    if (!decides.success) throw new RiskRecordUnreadable(`task ${row.taskId}: stored check "${row.name}" records decides that do not parse: ${z.prettifyError(decides.error)}`);
    return decides.data === null ? [] : decides.data;
  });
}

/** The highest zone reported for the project's current plan revision: 1 for the first plan, else the latest revision's. */
async function burnZone(db: DbHandle, projectId: ProjectId): Promise<BurnZone | null> {
  const rows = await db
    .select({ zone: workBurnWarnings.zone })
    .from(workBurnWarnings)
    .where(
      and(
        eq(workBurnWarnings.projectId, projectId),
        sql`${workBurnWarnings.planRevision} = (SELECT COALESCE(max(${planRevisions.revision}), 1) FROM ${planRevisions} WHERE ${planRevisions.projectId} = ${projectId})`,
      ),
    );
  const zones = rows.map((row) => {
    const zone = ZoneSchema.safeParse(row.zone);
    if (!zone.success) throw new RiskRecordUnreadable(`project ${projectId}: a burn warning records zone ${JSON.stringify(row.zone)}`);
    return zone.data;
  });
  if (zones.includes("red")) return "red";
  return zones.includes("yellow") ? "yellow" : null;
}

/**
 * The register's records for one project. A record that does not parse is "unreadable", never read
 * as no risk; a fault of the database itself throws.
 */
export async function readRiskRecords(db: DbHandle, projectId: ProjectId): Promise<RiskRecords> {
  const current = await new VisionRepository(db).getCurrent(projectId);
  if (current === null) return { kind: "no-vision" };
  try {
    const version = readVisionVersion(current);
    const tasks = await delivering(db, projectId);
    const decided = await decidedBy(db, tasks.map((task) => task.id));
    return { kind: "read", version, standing: { tasks, decided, burnZone: await burnZone(db, projectId) } };
  } catch (err) {
    if (err instanceof VisionUnreadable || err instanceof RiskRecordUnreadable) return { kind: "unreadable", detail: err.message };
    throw err;
  }
}

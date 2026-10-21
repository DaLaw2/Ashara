import { sql } from "drizzle-orm";
import { z } from "zod";
import { checkReports, readReportRecords } from "./client-reports.js";
import type { Database } from "./database.js";
import { projectState } from "./project-state.js";
import { checkTextFacts, readTextFactRecords } from "./text-facts.js";
import type { TextFactRecords } from "./text-facts.js";

/**
 * I4 and I9 on a database that is not a simulator run's: a kept run's store, loaded and migrated
 * forward (scripts/replay-run-state.ts). Only what the records hold is judged: nothing here reads a
 * repository's git history, so I4's clauses on main are not, and every other invariant is the
 * run's, which a dump does not have.
 */

export interface StoredTextViolation {
  readonly invariant: "I4" | "I9";
  readonly key: string;
  readonly statement: string;
}

/** A brief as today's composer states it for a recorded session, judged in place of the recorded one. */
export type RecomposedBrief = TextFactRecords["briefs"][number];

const projectRow = z.object({ status: z.string() });
const itemRow = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  level: z.string(),
  workKind: z.string().nullable(),
  origin: z.string().nullable(),
  mergeCommit: z.string().nullable(),
  mergeKind: z.string().nullable(),
  blockedReason: z.unknown(),
});
const checkedRow = z.object({ taskId: z.string() });

/** The project a judgement was asked for has no row. */
class StoredProjectMissing extends Error {
  constructor(readonly projectId: string) {
    super(`project ${projectId} has no projects row; nothing it was told can be judged`);
    this.name = "StoredProjectMissing";
  }
}

/**
 * I4 and I9 on one project's stored records. `briefs` is "as-recorded" to judge the briefs the
 * sessions recorded, or the briefs today's composer states for them.
 */
export async function judgeStoredText(
  db: Database,
  projectId: string,
  briefs: "as-recorded" | readonly RecomposedBrief[],
): Promise<StoredTextViolation[]> {
  const rows = async <T>(schema: z.ZodType<T>, query: ReturnType<typeof sql>): Promise<T[]> =>
    z.array(schema).parse((await db.execute(query)).rows);
  const [project] = await rows(projectRow, sql`SELECT ${projectState} AS status FROM projects WHERE id = ${projectId}`);
  if (project === undefined) throw new StoredProjectMissing(projectId);
  const items = await rows(
    itemRow,
    sql`SELECT id, title, status, level, work_kind AS "workKind", task_spec->>'origin' AS origin,
           merge_commit AS "mergeCommit",
               merge_kind AS "mergeKind", blocked_reason AS "blockedReason"
        FROM work_items WHERE project_id = ${projectId} ORDER BY created_at, id`,
  );
  const checked = new Set(
    (
      await rows(checkedRow, sql`SELECT DISTINCT task_id AS "taskId" FROM task_checks WHERE project_id = ${projectId}`)
    ).map((row) => row.taskId),
  );
  // A dump holds no checkout: the public interface a delivered report quotes from main is not judged.
  const recorded = await readTextFactRecords(db, projectId, null);
  const facts = briefs === "as-recorded" ? recorded : { ...recorded, briefs };
  const reports = await readReportRecords(db, projectId);
  // I4 judges a delivered report only on an accepted project. A kept run ends stopped or reopened
  // as often as accepted, and its delivered report was composed while it was accepted: judged so.
  const wasAccepted =
    project.status !== "accepted" && reports.sweeps.some((sweep) => sweep.passed && sweep.reportId !== null);
  const delivered = wasAccepted
    ? checkReports(reports, { status: "accepted" }, items, checked).filter(
        (found) => found.key.startsWith("delivered-") || found.key.startsWith("accepted-"),
      )
    : [];
  return [
    ...[...checkReports(reports, project, items, checked), ...delivered].map((found) => ({
      invariant: "I4" as const,
      ...found,
    })),
    ...checkTextFacts(facts).map((found) => ({ invariant: "I9" as const, ...found })),
  ];
}

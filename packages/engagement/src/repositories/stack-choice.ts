import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { projects } from "@ashara/db";
import { clientMessages } from "@ashara/db/schema/engagement";
import type { Database, DbHandle } from "@ashara/db";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import { latestEnvironmentStatement } from "@ashara/delivery/reads";
import { noOpenStop, projectAtWork } from "../predicates.js";
import { REPORT_SUBJECT } from "../report-subjects.js";
import type { RevisionRecord } from "../vision-language/contract-op.js";
import type { StoredVision, VisionAppend } from "../vision.js";
import { VisionRepository } from "./vision.js";

// The stack Sprint 0 chose, told to the client once: a completed environment task
// with a statement is due while its project has no 'stack-choice' report.

interface DueStackChoiceRow {
  readonly projectId: ProjectId;
  readonly taskId: string;
  readonly statement: string;
  /** The project's current vision, or null when it has none. */
  readonly vision: StoredVision | null;
}

/**
 * Every active project whose latest completed environment task carries a statement and that has
 * no stack-choice report, oldest project first. A project the client stopped, or has a stop
 * awaiting the Liaison, is not reported on.
 */
export async function listDueStackChoices(db: DbHandle): Promise<DueStackChoiceRow[]> {
  const candidates = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        projectAtWork(),
        noOpenStop(projects.id),
        sql`NOT EXISTS (SELECT 1 FROM client_messages m WHERE m.project_id = projects.id AND m.reports_on = ${REPORT_SUBJECT.stackChoice})`,
      ),
    )
    .orderBy(asc(projects.createdAt), asc(projects.id));

  const visions = new VisionRepository(db);
  const due: DueStackChoiceRow[] = [];
  for (const candidate of candidates) {
    // The report tells the client the environment is set up: only a task whose merge is on record did that.
    const task = await latestEnvironmentStatement(db, candidate.id);
    if (task === null) continue;
    const projectId = parseProjectId(candidate.id, "projects.id");
    due.push({ projectId, taskId: task.taskId, statement: task.statement, vision: await visions.getCurrent(projectId) });
  }
  return due;
}

/** The project's vision moved past the version the stack choice was composed against. */
class StackChoiceVisionMoved extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly basedOn: number,
    readonly current: number | null,
  ) {
    super(
      `stack choice for project ${projectId} was composed against vision v${basedOn}, ` +
        `but the current version is ${current === null ? "none" : `v${current}`}; nothing was written`,
    );
    this.name = "StackChoiceVisionMoved";
  }
}

interface StackChoiceWrite {
  readonly projectId: ProjectId;
  /** The vision version appended after the one the choice was composed against. */
  readonly vision: VisionAppend;
  /** The revision record written with it. */
  readonly revision: RevisionRecord;
  readonly report: string;
}

/**
 * In one transaction, with the project row locked: posts the stack-choice report and appends the next
 * vision version, a copy of the one it was composed against with the new inferences. A project already
 * reported on gets nothing new ("already-reported"): the unique index on (project_id, reports_on)
 * admits one report. A project no longer at work under the lock (stopped, accepted or halted since it
 * was listed, or with a stop awaiting the Liaison) gets nothing ("not-due"): the report says work
 * proceeds, and it is posted once the project is at work again.
 */
export async function recordStackChoice(db: Database, write: StackChoiceWrite): Promise<"recorded" | "already-reported" | "not-due"> {
  return db.transaction(async (tx) => {
    // The lifecycle guard and the halt guard each lock the row to write: read after the lock, the standing holds until commit.
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, write.projectId)).for("update");
    const [due] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, write.projectId), projectAtWork(), noOpenStop(projects.id)));
    if (due === undefined) return "not-due";
    const inserted = await tx
      .insert(clientMessages)
      .values({ projectId: write.projectId, direction: "outbound", kind: "report", body: write.report, inReplyTo: null, reportsOn: REPORT_SUBJECT.stackChoice })
      .onConflictDoNothing({ target: [clientMessages.projectId, clientMessages.reportsOn], where: isNotNull(clientMessages.reportsOn) })
      .returning({ id: clientMessages.id });
    if (inserted.length === 0) return "already-reported";

    const appended = await new VisionRepository(tx).append(write.projectId, write.vision, write.revision);
    if (appended.kind === "moved") throw new StackChoiceVisionMoved(write.projectId, write.vision.basedOnVersion, appended.current);
    return "recorded";
  });
}

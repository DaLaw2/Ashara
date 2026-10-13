import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { Database, DbHandle } from "../connection.js";
import { clientMessages, projects, visionDocuments, workItems } from "../schema.js";
import { noOpenStop } from "./project.js";

// The stack Sprint 0 chose, told to the client once (migration 034): a completed environment task
// with a statement is due while its project has no 'stack-choice' report.

const SUBJECT = "stack-choice";

/** The vision version a stack choice is appended after, as stored. */
interface StoredVision {
  readonly version: number;
  /** vision_documents.inferences as stored; Engagement parses it. */
  readonly inferences: unknown;
}

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
        eq(projects.status, "active"),
        noOpenStop(projects.id),
        sql`NOT EXISTS (SELECT 1 FROM client_messages m WHERE m.project_id = projects.id AND m.reports_on = ${SUBJECT})`,
      ),
    )
    .orderBy(asc(projects.createdAt), asc(projects.id));

  const due: DueStackChoiceRow[] = [];
  for (const candidate of candidates) {
    const [task] = await db
      .select({ id: workItems.id, statement: workItems.environmentStatement })
      .from(workItems)
      .where(
        and(
          eq(workItems.projectId, candidate.id),
          eq(workItems.workKind, "environment"),
          eq(workItems.status, "Completed"),
          isNotNull(workItems.environmentStatement),
          // The report tells the client the environment is set up: only a task whose merge is
          // on record (migration 041) did that, not one an operator marked Completed.
          isNotNull(workItems.mergeCommit),
        ),
      )
      .orderBy(desc(workItems.updatedAt), desc(workItems.id))
      .limit(1);
    if (task === undefined || task.statement === null) continue;
    const [vision] = await db
      .select({ version: visionDocuments.version, inferences: visionDocuments.inferences })
      .from(visionDocuments)
      .where(eq(visionDocuments.projectId, candidate.id))
      .orderBy(desc(visionDocuments.version))
      .limit(1);
    due.push({
      projectId: parseProjectId(candidate.id),
      taskId: task.id,
      statement: task.statement,
      vision: vision === undefined ? null : { version: vision.version, inferences: vision.inferences },
    });
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
  /** The vision version the new one is appended after; every field but the inferences is copied from it. */
  readonly basedOnVersion: number;
  readonly inferences: unknown;
  readonly changeReason: string;
  readonly report: string;
}

/**
 * In one transaction: posts the stack-choice report and appends the next vision version, a copy of
 * `basedOnVersion` with the new inferences. A project already reported on gets nothing new
 * ("already-reported"): the unique index on (project_id, reports_on) admits one report.
 */
export async function recordStackChoice(db: Database, write: StackChoiceWrite): Promise<"recorded" | "already-reported"> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(clientMessages)
      .values({ projectId: write.projectId, direction: "outbound", kind: "report", body: write.report, inReplyTo: null, reportsOn: SUBJECT })
      .onConflictDoNothing({ target: [clientMessages.projectId, clientMessages.reportsOn], where: isNotNull(clientMessages.reportsOn) })
      .returning({ id: clientMessages.id });
    if (inserted.length === 0) return "already-reported";

    const [current] = await tx
      .select()
      .from(visionDocuments)
      .where(eq(visionDocuments.projectId, write.projectId))
      .orderBy(desc(visionDocuments.version))
      .limit(1);
    if (current === undefined || current.version !== write.basedOnVersion) {
      throw new StackChoiceVisionMoved(write.projectId, write.basedOnVersion, current?.version ?? null);
    }
    await tx.insert(visionDocuments).values({
      projectId: write.projectId,
      version: current.version + 1,
      visionText: current.visionText,
      summary: current.summary,
      inferences: write.inferences,
      scopeBoundaries: current.scopeBoundaries,
      confirmedDirections: current.confirmedDirections,
      openQuestions: current.openQuestions,
      changeReason: write.changeReason,
    });
    return "recorded";
  });
}

import { and, eq } from "drizzle-orm";
import { insertedRow } from "@ashara/db";
import { clientMessages, toldReports } from "@ashara/db/schema/engagement";
import type { DbHandle } from "@ashara/db";
import { haltEpisodeOf } from "@ashara/delivery/predicates";
import { planRevisionProjects } from "@ashara/delivery/reads";
import { recordedSweep } from "@ashara/quality/published-reads";
import type { ToldSubjectKind } from "../predicates.js";

// The Liaison's told record: one told_reports row per subject it told the client of, written in the
// transaction that posts the report. The primary key on (subject_kind, subject_id) admits one, so a
// retried, concurrent or restarted post tells the client once.

/** One subject a report tells of. */
export interface ToldSubject {
  readonly kind: ToldSubjectKind;
  readonly id: string;
}

/** A concurrent post recorded the subject first: this transaction's report is rolled back. */
class SubjectToldConcurrently extends Error {
  constructor(readonly subject: ToldSubject) {
    super(`the report on ${subject.kind} ${subject.id} was recorded by a concurrent post; this one is rolled back`);
    this.name = "SubjectToldConcurrently";
  }
}

/** Posts an outbound report to the project, in reply to `inReplyTo` when it answers a message, and returns its id. */
export async function insertOutboundReport(tx: DbHandle, projectId: string, body: string, inReplyTo: string | null, what: string): Promise<string> {
  const rows = await tx
    .insert(clientMessages)
    .values({ projectId, direction: "outbound", kind: "report", body, inReplyTo })
    .returning({ id: clientMessages.id });
  return insertedRow(rows, "client_messages", what).id;
}

/** A told record was asked for a subject its owner does not publish as the project's: a report on it tells the client of nothing of theirs. */
class ToldSubjectNotOfProject extends Error {
  constructor(
    readonly kind: ToldSubjectKind,
    readonly subjectIds: readonly string[],
    readonly projectId: string,
  ) {
    super(`cannot record a told ${kind} report of project ${projectId}: ${subjectIds.join(", ")} is no ${kind} subject of that project`);
    this.name = "ToldSubjectNotOfProject";
  }
}

/**
 * The project each subject belongs to, as the subject's owner publishes it: a halt episode
 * Delivery's, a plan revision Delivery's, a delivered report's passed sweep Quality's. A subject
 * its owner holds no record of is absent.
 */
async function subjectProjects(tx: DbHandle, kind: ToldSubjectKind, subjectIds: readonly string[]): Promise<Map<string, string>> {
  switch (kind) {
    case "plan-revision":
      return planRevisionProjects(tx, subjectIds);
    case "project-blocked":
    case "project-resumed": {
      const projects = new Map<string, string>();
      for (const id of subjectIds) {
        const episode = await haltEpisodeOf(tx, id);
        if (episode !== null) projects.set(id, episode.projectId);
      }
      return projects;
    }
    case "delivered": {
      const projects = new Map<string, string>();
      for (const id of subjectIds) {
        const sweep = await recordedSweep(tx, id, true);
        if (sweep !== null) projects.set(id, sweep.projectId);
      }
      return projects;
    }
  }
}

/**
 * Records `reportId` as telling each of `subjectIds`; returns how many were recorded, the others
 * being told already. A subject that is not the project's, as its owner publishes it, throws.
 */
export async function recordTold(tx: DbHandle, kind: ToldSubjectKind, subjectIds: readonly string[], projectId: string, reportId: string): Promise<number> {
  if (subjectIds.length === 0) return 0;
  const owners = await subjectProjects(tx, kind, subjectIds);
  const foreign = subjectIds.filter((id) => owners.get(id) !== projectId);
  if (foreign.length > 0) throw new ToldSubjectNotOfProject(kind, foreign, projectId);
  const recorded = await tx
    .insert(toldReports)
    .values(subjectIds.map((subjectId) => ({ subjectKind: kind, subjectId, projectId, reportId })))
    .onConflictDoNothing()
    .returning({ subjectId: toldReports.subjectId });
  return recorded.length;
}

/**
 * Posts the report on `subject` once: `post` writes the report and what goes with it, and the
 * subject is recorded as told by it, in one transaction. A subject already told gets nothing:
 * "already-posted", and a post that a concurrent one recorded first is rolled back whole.
 */
export async function tellOnce(
  db: DbHandle,
  subject: ToldSubject,
  post: (tx: DbHandle) => Promise<{ readonly projectId: string; readonly reportId: string }>,
): Promise<"posted" | "already-posted"> {
  try {
    return await db.transaction(async (tx): Promise<"posted" | "already-posted"> => {
      const [onFile] = await tx
        .select({ reportId: toldReports.reportId })
        .from(toldReports)
        .where(and(eq(toldReports.subjectKind, subject.kind), eq(toldReports.subjectId, subject.id)));
      if (onFile !== undefined) return "already-posted";
      const { projectId, reportId } = await post(tx);
      if ((await recordTold(tx, subject.kind, [subject.id], projectId, reportId)) === 0) throw new SubjectToldConcurrently(subject);
      return "posted";
    });
  } catch (err) {
    if (err instanceof SubjectToldConcurrently) return "already-posted";
    throw err;
  }
}

import { isNotNull } from "drizzle-orm";
import { clientMessages } from "@ashara/db/schema/engagement";
import type { DbHandle } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import type { PlanReportSubject } from "../report-subjects.js";
import type { TableVerdicts } from "../guarantee-report.js";
import { insertGuaranteeVerdicts } from "./guarantee-report.js";
import { insertOutboundReport, recordTold, tellOnce } from "./told-report.js";

// The Liaison's write of its reports on Delivery's planning outcomes, which Delivery publishes in its
// plan-report reads: a first plan's or a planning stop's report, once per project by the partial
// unique index on (project_id, reports_on), and a plan revision's, once per revision by its told
// record. A revision the first-plan report describes is recorded as told by it.

/** A revision the first-plan report was to describe is already told: nothing of the report is recorded. */
class RevisionsNotFoldable extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly expected: readonly string[],
    readonly recorded: number,
  ) {
    super(
      `project ${projectId}: the first-plan report describes plan revision(s) ${expected.join(", ")}, ` +
        `but ${recorded} of ${expected.length} were untold; no report is posted`,
    );
    this.name = "RevisionsNotFoldable";
  }
}

/**
 * Posts an outbound report on a planning outcome. The partial unique index on (project_id,
 * reports_on) admits one per outcome: a second post inserts nothing and returns "already-posted".
 * `revisionIds` are the revisions a first-plan report describes: each is recorded as told by it in
 * the same transaction, so none of them is reported again on its own. A planning-stopped report's
 * verdicts are posted with it.
 */
export async function postPlanReport(
  db: DbHandle,
  projectId: ProjectId,
  subject: PlanReportSubject,
  body: string,
  revisionIds: readonly string[],
  verdicts: TableVerdicts | null,
): Promise<"posted" | "already-posted"> {
  return db.transaction(async (tx): Promise<"posted" | "already-posted"> => {
    const [inserted] = await tx
      .insert(clientMessages)
      .values({ projectId, direction: "outbound", kind: "report", body, inReplyTo: null, reportsOn: subject })
      .onConflictDoNothing({
        target: [clientMessages.projectId, clientMessages.reportsOn],
        where: isNotNull(clientMessages.reportsOn),
      })
      .returning({ id: clientMessages.id });
    if (inserted === undefined) return "already-posted";
    const recorded = await recordTold(tx, "plan-revision", revisionIds, projectId, inserted.id);
    if (recorded !== revisionIds.length) throw new RevisionsNotFoldable(projectId, revisionIds, recorded);
    if (verdicts !== null) await insertGuaranteeVerdicts(tx, projectId, inserted.id, verdicts);
    return "posted";
  });
}

/** A plan revision as its report is posted: its project and the client message whose correction it took in (null for a repair). */
export interface PlanRevisionToTell {
  readonly revisionId: string;
  readonly projectId: string;
  readonly requestedBy: string | null;
}

/**
 * Posts the Liaison's one report on a plan revision, in reply to the earliest client message whose
 * correction it took in (in reply to nothing for a plan repair, which no client asked for), and
 * records it as told of the revision in the same transaction; a revision already told gets nothing.
 */
export async function postPlanRevisionReport(db: DbHandle, revision: PlanRevisionToTell, body: string): Promise<"posted" | "already-posted"> {
  return tellOnce(db, { kind: "plan-revision", id: revision.revisionId }, async (tx) => ({
    projectId: revision.projectId,
    reportId: await insertOutboundReport(tx, revision.projectId, body, revision.requestedBy, `post the report on plan revision ${revision.revisionId}`),
  }));
}

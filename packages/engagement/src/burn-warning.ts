import { burnZoneOf, projectWorkBudget } from "@ashara/finance";
import type { BurnZone, WorkBudgets } from "@ashara/finance";
import { containEach } from "@ashara/shared";
import type { ProjectId, StepContainment, StepFaulted, UnreadSubject } from "@ashara/shared";
import { registerOf, registerParagraph } from "./early-warning.js";
import type { RiskRecordReader, RiskRecords } from "./early-warning.js";

// The Liaison's early warning on a project's work ledger: when the
// model requests a project has drawn run ahead of the implementation of its current plan revision,
// the client is told once per zone and revision what was spent, what is done and what Ashara does
// next; in the red zone the operator is told too, before the budget runs out. The zone is decided
// from the ledger's own rows each cycle, and each zone a project entered is recorded with its report,
// so a restart neither repeats one nor loses one.

/** One project at work, as its ledger and its plan stand now. */
export interface ProjectBurn {
  readonly projectId: ProjectId;
  /** The current plan revision: 1 for the first plan, then the latest plan_revisions row's. */
  readonly planRevision: number;
  /** Every model request the project drew (llm_calls), in any state. */
  readonly drawnRequests: number;
  /** The requests the owner granted the project (work_grants). */
  readonly grantedRequests: number;
  /** The revision's implementation tasks: every one the project holds that no revision superseded. */
  readonly plannedTasks: number;
  readonly completedTasks: number;
  /** The zones already reported for this revision. */
  readonly reported: readonly BurnZone[];
}

/** The figures a warning is decided on and states, as recorded with it. */
interface BurnFigures {
  readonly drawnRequests: number;
  readonly budgetRequests: number;
  readonly reserveRequests: number;
  readonly upstreamRequests: number;
  readonly plannedTasks: number;
  readonly completedTasks: number;
}

/** One warning to record and post: its zone, the figures, what the client reads and, on red, what the operator does. */
export interface BurnWarning {
  readonly projectId: ProjectId;
  readonly planRevision: number;
  readonly zone: BurnZone;
  readonly figures: BurnFigures;
  readonly body: string;
  readonly operatorText: string | null;
}

/** Engagement's persistence port for burn warnings; each warning reissues the register of guarantees at risk. */
export interface BurnWarningStore extends RiskRecordReader {
  /** Every project at work, each read on its own: one whose rows do not read is its UnreadSubject. */
  projectBurns(): Promise<ReadonlyArray<ProjectBurn | UnreadSubject>>;
  /** Records the warning and posts its report, unless its zone, or a higher one, is already recorded for its revision. */
  postWarning(warning: BurnWarning): Promise<"posted" | "already-posted">;
}

interface BurnWarningOutcome {
  readonly kind: "posted" | "already-posted";
  readonly projectId: ProjectId;
  readonly zone: BurnZone;
}

/** What the core loop asks of the Liaison each cycle (no LLM call). */
export interface LiaisonBurnWarnings {
  runPending(): Promise<ReadonlyArray<BurnWarningOutcome | StepFaulted>>;
}

function requests(count: number): string {
  return `${count} model request${count === 1 ? "" : "s"}`;
}

/** What has been spent of the project's budget, and what of it is set aside. */
function spentWords(figures: BurnFigures): string {
  const reserve =
    figures.reserveRequests > 0
      ? ` A further ${requests(figures.reserveRequests)} of its budget are set aside for checking and accepting the finished work, and only that checking may use them.`
      : "";
  return `So far ${requests(figures.drawnRequests)} have been sent, of the ${requests(figures.upstreamRequests)} this project's work may use before it pauses.${reserve}`;
}

/** What of the current plan's building work is done, or that none is planned yet. */
function doneWords(figures: BurnFigures): string {
  if (figures.plannedTasks === 0) return "No building task of the current plan is planned yet, so none of it is finished.";
  return `${figures.completedTasks} of the ${figures.plannedTasks} building tasks of the current plan are finished.`;
}

/**
 * What the client reads when a project enters a zone: that the budget is running ahead of the work,
 * what was spent and what is done, as recorded with the warning, and what Ashara does next.
 */
function burnWarningReport(zone: BurnZone, figures: BurnFigures): string {
  const opening =
    zone === "red"
      ? "Most of the model requests this project's work may use are spent, and its plan is not finished."
      : "This project has used more of its budget of model requests than its finished work accounts for.";
  const next =
    zone === "red"
      ? "Ashara has told its operator. It goes on with the plan as it stands until those model requests are used up; then work on this " +
        "project pauses until the operator grants more, and you are told when it does."
      : "Ashara goes on with the plan as it stands. If the model requests this project's work may use are used up before it is finished, " +
        "work on it pauses until the operator grants more, and you are told when it does.";
  return [opening, `${spentWords(figures)} ${doneWords(figures)}`, next].join("\n\n");
}

/** What the operator is told when a project enters the red zone, with the figures and the command that grants more. */
function operatorBurnReport(projectId: ProjectId, planRevision: number, figures: BurnFigures): string {
  return (
    `work_burn red: project ${projectId} (plan revision ${planRevision}) has drawn ${figures.drawnRequests} of the ` +
    `${figures.upstreamRequests} model requests its upstream work may draw (budget ${figures.budgetRequests}, verification reserve ` +
    `${figures.reserveRequests}), with ${figures.completedTasks} of ${figures.plannedTasks} implementation tasks completed. It halts on ` +
    `its work budget when the rest is drawn; to grant more: npx tsx scripts/project.ts grant ${projectId} --requests <n> --reason <why>`
  );
}

/** The zone a project's burn is due to report, or null: none, or one already reported, or a lower one after a higher. */
function dueZone(burn: ProjectBurn, figures: BurnFigures): BurnZone | null {
  const zone = burnZoneOf(figures);
  if (zone === null || burn.reported.includes(zone)) return null;
  if (zone === "yellow" && burn.reported.includes("red")) return null;
  return zone;
}

/** The register's records once the zone this warning reports is entered, which is recorded only with the warning. */
function atZone(records: RiskRecords, zone: BurnZone): RiskRecords {
  return records.kind === "read" ? { ...records, standing: { ...records.standing, burnZone: zone } } : records;
}

export class BurnWarnings implements LiaisonBurnWarnings {
  constructor(
    private readonly store: BurnWarningStore,
    /** The deployment's work budgets, the reserve among them, which each project's figures are read against. */
    private readonly budgets: WorkBudgets,
    /** Each project's own fault is contained to it (containEach). */
    private readonly containment: StepContainment,
  ) {}

  /** Posts every warning due, each project's own failure contained to it; only a failure of the listing as a whole throws through. */
  async runPending(): Promise<ReadonlyArray<BurnWarningOutcome | StepFaulted>> {
    const burns = await this.store.projectBurns();
    const outcomes = await containEach(
      this.containment,
      "burn-warning",
      burns,
      (burn) => ({ id: burn.projectId, projectId: burn.projectId }),
      async (burn): Promise<BurnWarningOutcome | null> => {
        const budget = projectWorkBudget(this.budgets, burn.grantedRequests);
        const figures: BurnFigures = {
          drawnRequests: burn.drawnRequests,
          budgetRequests: budget.budgetRequests,
          reserveRequests: budget.reserveRequests,
          upstreamRequests: budget.upstreamRequests,
          plannedTasks: burn.plannedTasks,
          completedTasks: burn.completedTasks,
        };
        const zone = dueZone(burn, figures);
        if (zone === null) return null;
        const operatorText = zone === "red" ? operatorBurnReport(burn.projectId, burn.planRevision, figures) : null;
        const register = registerOf(atZone(await this.store.riskRecords(burn.projectId), zone));
        const kind = await this.store.postWarning({
          projectId: burn.projectId,
          planRevision: burn.planRevision,
          zone,
          figures,
          body: `${burnWarningReport(zone, figures)}\n\n${registerParagraph(burn.projectId, register)}`,
          operatorText,
        });
        // The operator's channel is the server's log and the recorded row (work_burn_warnings.operator_report).
        if (kind === "posted" && operatorText !== null) console.warn(`[work_burn] ${operatorText}`);
        return { kind, projectId: burn.projectId, zone };
      },
    );
    return outcomes.filter((outcome): outcome is BurnWarningOutcome | StepFaulted => outcome !== null);
  }
}

import { requestCount } from "./client-report-core.js";
import type { ReportAdd, ReportsById } from "./client-report-core.js";
import type { ReportRecords } from "./client-reports.js";

/** One zone of the work ledger's early warning a project entered, with its report's text. */
type BurnWarning = ReportRecords["burnWarnings"][number];

/**
 * The sentences a burn warning's report must carry, from its recorded figures, written here: what was
 * sent of what the project's work may use, the reserve when there is one, and what of the plan is done.
 */
function expectedBurnFigures(warning: BurnWarning): string {
  const reserve =
    warning.reserveRequests > 0
      ? ` A further ${requestCount(warning.reserveRequests)} of its budget are set aside for checking and ` +
        `accepting the finished work, and only that checking may use them.`
      : "";
  const done =
    warning.plannedTasks === 0
      ? "No building task of the current plan is planned yet, so none of it is finished."
      : `${warning.completedTasks} of the ${warning.plannedTasks} building tasks of the current plan are finished.`;
  return (
    `So far ${requestCount(warning.drawnRequests)} have been sent, of the ` +
    `${requestCount(warning.upstreamRequests)} this project's work may use before it pauses.${reserve} ${done}`
  );
}

/**
 * Whether a warning's recorded figures put it in its zone (the policy
 * defaults restated here): yellow at 50 percent of what upstream work may draw with at most 25
 * percent of the planned tasks done, red at 80 percent with the plan not finished, none planned
 * counting as none done.
 */
function zoneHolds(warning: BurnWarning): boolean {
  const drawn = warning.drawnRequests * 100;
  if (warning.zone === "red")
    return (
      drawn >= 80 * warning.upstreamRequests &&
      (warning.plannedTasks === 0 || warning.completedTasks < warning.plannedTasks)
    );
  if (warning.zone === "yellow")
    return drawn >= 50 * warning.upstreamRequests && warning.completedTasks * 100 <= 25 * warning.plannedTasks;
  return false;
}

/**
 * Each burn warning against its own record: its zone held on the figures it recorded, its figures
 * add up and never claim more requests than the ledger holds, its report states them, a red one told
 * the operator the same figures, and no zone was told twice in a revision nor yellow after red.
 */
export function checkBurnWarnings(records: ReportRecords, byId: ReportsById, add: ReportAdd): void {
  const told = new Set<string>();
  for (const warning of records.burnWarnings) {
    const at = `${warning.zone} warning of plan revision ${warning.planRevision}`;
    if (
      told.has(`${warning.planRevision}:${warning.zone}`) ||
      (warning.zone === "yellow" && told.has(`${warning.planRevision}:red`))
    ) {
      add("burn-warning-repeated", `the ${at} was told after the same or a higher zone of that revision`);
    }
    told.add(`${warning.planRevision}:${warning.zone}`);
    if (!zoneHolds(warning))
      add(
        "burn-warning-zone",
        `the ${at} records ${warning.drawnRequests} of ${warning.upstreamRequests} requests drawn and ` +
          `${warning.completedTasks} of ${warning.plannedTasks} tasks done, outside its zone`,
      );
    if (
      warning.upstreamRequests !== warning.budgetRequests - warning.reserveRequests ||
      warning.drawnRequests > warning.ledgerRequests
    ) {
      add(
        "burn-warning-figures",
        `the ${at} records ${warning.drawnRequests} drawn of a budget ${warning.budgetRequests} less reserve ` +
          `${warning.reserveRequests} = ${warning.upstreamRequests}; the ledger holds ${warning.ledgerRequests}`,
      );
    }
    const report = byId.get(warning.reportId);
    const figures = expectedBurnFigures(warning);
    if (report === undefined || !report.body.includes(figures)) {
      add(
        "burn-warning",
        `the ${at}'s report does not state "${figures.slice(0, 200)}"; it reads ` +
          `"${report?.body.slice(0, 200) ?? "no report"}"`,
      );
    }
    const operatorFigures =
      `has drawn ${warning.drawnRequests} of the ${warning.upstreamRequests} model requests its upstream work ` +
      `may draw`;
    if ((warning.zone === "red") !== (warning.operatorReport?.includes(operatorFigures) === true)) {
      add(
        "burn-warning-operator",
        `the ${at} ${warning.zone === "red" ? "did not tell" : "told"} the operator "${operatorFigures}"`,
      );
    }
  }
}

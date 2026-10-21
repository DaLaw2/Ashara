// Engagement's vocabulary of the subjects a report to the client is on (client_messages.reports_on):
// a project gets at most one report on each, by the unique index on (project_id, reports_on). Each
// subject is spelled here once; a reader or writer in any context names it from here, and the
// column's CHECK holds exactly REPORT_SUBJECTS. This module imports nothing else of Engagement, so a
// context Engagement reads can import it without a cycle at load time.

/** Each subject a report is on, by name. */
export const REPORT_SUBJECT = {
  firstPlan: "first-plan",
  planningStopped: "planning-stopped",
  clientStop: "client-stop",
  stackChoice: "stack-choice",
  contractDraft: "contract-draft",
} as const;

/**
 * Every subject a report is on: the values client_messages.reports_on admits, and the ones a
 * client_messages row read back is parsed against (client-message.ts).
 */
export const REPORT_SUBJECTS = [
  REPORT_SUBJECT.firstPlan,
  REPORT_SUBJECT.planningStopped,
  REPORT_SUBJECT.clientStop,
  REPORT_SUBJECT.stackChoice,
  REPORT_SUBJECT.contractDraft,
] as const;

/** The outcomes of planning a report is on: the first plan, or a first planning that stopped. */
export type PlanReportSubject = typeof REPORT_SUBJECT.firstPlan | typeof REPORT_SUBJECT.planningStopped;

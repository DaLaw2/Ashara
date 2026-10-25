/**
 * The pairs of type declarations mirrored-types.ts excuses: each a shared name or a shared type of
 * declarations that are distinct concepts, named with why. An entry with no reason, or that names no
 * such declarations, is a violation of that lint, so the list cannot outlive what it excuses.
 */

export interface AllowedPair {
  /** The declared names: one for a shared name, each for a shared type. */
  readonly names: readonly string[];
  /** Root-relative, `/`-separated: every file that declares one of `names`. */
  readonly files: readonly string[];
  readonly reason: string;
}

const SIMULATOR_ROW = "the simulator's own zod row of what it reads back from the database to judge a run: it states what the run must show, so it is never imported from the code it judges";
const DERIVED_ALIAS = "a local alias derived from the production type by a type operator (its parameters, an indexed access), so it is that type and cannot drift from it; the production module exports no name for it";

export const MIRRORED_ALLOWED: readonly AllowedPair[] = [
  { names: ["ProjectRow"], files: ["packages/db/src/repositories/project.ts", "packages/integration/src/simulator/invariants.ts"], reason: SIMULATOR_ROW },
  { names: ["BurnWarning"], files: ["packages/engagement/src/burn-warning.ts", "packages/integration/src/simulator/client-report-burn.ts"], reason: SIMULATOR_ROW },
  { names: ["StoredGuarantee"], files: ["packages/engagement/src/vision-language/guarantee.ts", "packages/integration/src/simulator/stand-ins/liaison.ts"], reason: SIMULATOR_ROW },
  {
    names: ["IntakeRecords"],
    files: ["packages/engagement/src/intake.ts", "packages/integration/src/simulator/intake-readings.ts"],
    reason: "Engagement's is what an intake asked and inferred; the simulator's is what it reads back of a tender's reading (its questions posted, its vision written)",
  },
  {
    names: ["TableSource"],
    files: ["packages/engagement/src/guarantee-report.ts", "packages/integration/src/simulator/client-report-core.ts"],
    reason: "Engagement's names the record a terminal message's table is read from; the simulator's is the sweep, vision version and commit it reads back for a report's table",
  },
  {
    names: ["CorrectionReading"],
    files: ["packages/engagement/src/correction.ts", "packages/integration/src/simulator/stand-ins/liaison.ts"],
    reason: "Engagement's is the model's reading of a correction; the stand-in's is its own answer, read or fallen back to an exclusion",
  },
  {
    names: ["Risk"],
    files: ["packages/engagement/src/early-warning.ts", "packages/integration/src/server/terminal-reports.ts"],
    reason: "Engagement's is why one guarantee is at risk; the test harness's names the risk register a halted terminal event carries, derived from Engagement's own type",
  },
  {
    names: ["TaskLanes"],
    files: ["packages/delivery/src/types.ts", "packages/integration/src/simulator/interleave.ts"],
    reason: `${DERIVED_ALIAS}; a simulator file imports from another package only the names its rules list`,
  },
  { names: ["TerminalEvent"], files: ["packages/engagement/src/terminal-report.ts", "packages/integration/src/server/terminal-reports.ts"], reason: DERIVED_ALIAS },
  {
    names: ["Direction"],
    files: ["packages/engagement/src/vision-language/contract-op.ts", "packages/integration/src/simulator/tape.ts"],
    reason: "Engagement's is which way a contract revision moves a guarantee; the simulator's is a draw its tape takes",
  },
  {
    names: ["Coverage"],
    files: ["packages/integration/src/simulator/coverage.ts", "packages/quality/src/guarantee-verdict.ts"],
    reason: "Quality's is whether a sweep covers the contract in force; the simulator's is what a batch of runs reached",
  },
  {
    names: ["Outcome"],
    files: ["packages/integration/src/simulator/invariants.ts", "packages/quality/src/repositories/reviewer-outcome.ts", "packages/workplace/src/outcome.ts"],
    reason: "Workplace's is how an attempt ended, Quality's how a reviewer's verdict was borne out, the simulator's what a run ended in",
  },
  {
    names: ["WorkKind"],
    files: ["packages/integration/src/simulator/stand-ins/agent.ts", "packages/organization/src/work-kind.ts"],
    reason: "Organization's is the kind of work a role is assigned; the stand-in's is the scope of an attempt's scripted draws, which tells the scaffold apart",
  },
  {
    names: ["TaskSpec"],
    files: ["packages/delivery/src/decomposition-types.ts", "packages/workplace/src/task-spec.ts"],
    reason: "Delivery's is a planned task's specification with its origin and sources; Workplace's is the goal, end state, scope and deliverables a brief states",
  },
  {
    names: ["ReplanContext"],
    files: ["packages/delivery/src/domain/work-item.ts", "packages/workplace/src/replan-context.ts"],
    reason: "Delivery's is the replan context it writes on a blocked reason; Workplace's is its own zod read, at its boundary, of the part its brief shows, and Workplace may not import Delivery, which is downstream of it",
  },
  {
    names: ["RevisionCause"],
    files: ["packages/delivery/src/replan-port.ts", "packages/engagement/src/vision-language/contract-op.ts"],
    reason: "Delivery's is what asked for a plan revision; Engagement's is why a vision revision was written",
  },
  {
    names: ["JudgedGuarantee"],
    files: ["packages/evaluation/src/hidden-verdict.ts", "packages/quality/src/guarantee-verdict.ts"],
    reason: "Quality's is what its verdict reads of a guarantee; Evaluation's is the hidden suite's verdict on one",
  },
  {
    names: ["Spend"],
    files: ["packages/evaluation/src/run-report-format.ts", "packages/finance/src/llm-call-repository.ts"],
    reason: "Finance's is a scope's spend as its cap counts it; the run report's is measured spend over a set of calls",
  },
  {
    names: ["Cell"],
    files: ["packages/evaluation/src/trust-stats.ts", "packages/execution-infra/src/podman.ts"],
    reason: "Execution Infrastructure's is a container; the trust statistics' is one cell of a confusion table",
  },
  {
    names: ["Delivery"],
    files: ["packages/evaluation/src/trust-stats.ts", "packages/quality/src/dispatch-result.ts"],
    reason: "Quality's is what a completed task delivered; the trust statistics' counts how one arm's runs per stack ended",
  },
  {
    names: ["JsonValue"],
    files: ["packages/quality/src/dispatch-result.ts", "packages/shared/src/error-chain.ts"],
    reason: "the shared kernel's is plain JSON data; Quality's event fields also admit an undefined member, which JSON.stringify drops",
  },
  {
    names: ["NewSuiteReviewFindings", "SuiteReviewFindingsEntry"],
    files: ["packages/delivery/src/execution/dispatch-run-deps.ts", "packages/quality/src/repositories/suite-review.ts"],
    reason: "Delivery's port states what its suite-review step records; Quality's repository is what fills it, and neither context may import the other's module outside its ACL",
  },
  {
    names: ["RunBudgetFinding", "VerificationSplitBreak"],
    files: ["scripts/simulator-run-budget.ts", "scripts/verification-split.ts"],
    reason: "each check's own finding: they hold a file, a line and a reason today, and a field one check comes to need must not reach the other",
  },
  {
    names: ["EnvironmentPlanning", "LayoutPlanning"],
    files: ["packages/delivery/src/decomposition-types.ts"],
    reason: "where a plan's environment comes from and where its product's layout does: two inputs a revision decides apart, which share a shape today",
  },
  {
    names: ["MainFile", "PublicInterface"],
    files: ["packages/integration/src/simulator/text-facts.ts", "packages/quality/src/public-interface.ts"],
    reason: "the simulator's own read of a file of main by the observer's git: it states what the run must show, so it is never imported from the code it judges",
  },
  {
    names: ["ProjectBlockKind", "StatedKind"],
    files: ["packages/engagement/src/block-report.ts", "packages/integration/src/simulator/client-report-halt.ts"],
    reason: "the simulator's own judgement of which halt kinds a report states, derived from its table: it states what the run must show, so it is never imported from the code it judges",
  },
  { names: ["TurnToolCall", "ToolCall"], files: ["packages/model-access/src/turn.ts", "packages/workplace/src/attempt.ts"], reason: DERIVED_ALIAS },
  { names: ["SecondOpinionStrength", "Strength"], files: ["packages/evaluation/src/run-report-format.ts", "packages/model-access/src/types.ts"], reason: DERIVED_ALIAS },
  { names: ["RiskRecords", "Risk"], files: ["packages/engagement/src/early-warning.ts", "packages/integration/src/server/terminal-reports.ts"], reason: DERIVED_ALIAS },
  {
    names: ["VisionItem", "VisionSource"],
    files: ["packages/delivery/src/decomposition-types.ts", "packages/engagement/src/vision-language/vision-source.ts"],
    reason: "Delivery's name, in its own language, for an item of the Engagement vision it plans from, taken through its ACL: it names Engagement's type whole, so it cannot drift from it",
  },
  {
    names: ["AnswerRecording", "CorrectionRecording"],
    files: ["packages/engagement/src/answers.ts", "packages/engagement/src/client-change.ts"],
    reason: "how recording a client's answer ended and how recording a correction did: two writes whose outcomes share a shape today",
  },
  {
    names: ["WorkItemStatus", "StatusTarget"],
    files: ["packages/delivery/src/work-item-language/work-item-status.ts", "packages/server/src/routes.ts"],
    reason: "the server's zod read, at its HTTP boundary, of the status a request asks for: derived from its own schema, which is built over Delivery's statuses",
  },
  {
    names: ["Fixture"],
    files: ["packages/integration/src/server/dispatch-loops-ledger.test.ts", "packages/integration/src/server/work-budget-loop.test.ts"],
    reason: "each integration test's own fixture of the loop it drives: they share a shape today, and each changes with its own test",
  },
  {
    names: ["TaskRun"],
    files: ["packages/integration/src/server/merge-conflict-retry.test.ts", "packages/integration/src/server/task-checks-execution.test.ts"],
    reason: "each integration test's own record of a task it runs: they share a shape today, and each changes with its own test",
  },
];

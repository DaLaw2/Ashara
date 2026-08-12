import { blockedReasonToRecord, RUN_SCOPE_PRE_SCOPING, RUN_SCOPE_AD_HOC } from "@ashara/shared";
import type { TerminationCounts, TerminationStop, StalledCause, StopReason, TerminationPlanExhausted } from "../termination.js";
import type { RunSummary, ShippedItem, AbandonedItem, AbandonKind, CoverageGap, EndpointCoverageGap } from "../run-summary.js";
import type { AcceptanceVerdict } from "../acceptance.js";
import type { CompletionFigure } from "../completion-figure.js";
import type { TerminationItemSnapshot } from "./termination.js";
import type { EventSink } from "./ports.js";

/**
 * Format a CompletionFigure for the narrative. The figure is comparable across
 * runs and stacks because it is a ratio derived from the contract's declared
 * surface (endpoints, checks, modules) — not from task counts, which vary by
 * decomposition strategy.
 */
function formatCompletionFigure(figure: CompletionFigure | undefined): string {
  if (figure === undefined) return "";
  if (figure.kind === "unknown") return ` Completion: unknown (${figure.reason}).`;
  const pct = Math.round(figure.ratio * 100);
  return ` Completion: ${pct}% (${figure.numerator}/${figure.denominator} contract items verified).`;
}

export interface RunSummaryItem extends TerminationItemSnapshot {
  readonly title: string;
  readonly blockedReason?: import("@ashara/shared").StoredBlockedReason;
  /** Which run created this item (a runId, RUN_SCOPE_PRE_SCOPING, or RUN_SCOPE_AD_HOC). */
  readonly runScope: string;
}

export interface RunSummaryInput {
  readonly items: readonly RunSummaryItem[];
  /** The runId of the current run — used to scope counts in the narrative. */
  readonly currentRunScope: string;
  readonly endpointGaps?: readonly EndpointCoverageGap[];
  readonly acceptance?: AcceptanceVerdict;
  /** Pre-computed completion figure; passed through to the RunSummary. */
  readonly completionFigure?: CompletionFigure;
}

function deriveStopReason(decision: TerminationStop | TerminationPlanExhausted, acceptance?: AcceptanceVerdict): StopReason {
  if (decision.decision === "stop") return decision.reason as StopReason;
  // No verdict at all is not a passing verdict — the plan exhausted without
  // anything confirming the vision was met.
  if (acceptance === undefined) return "unverified";
  switch (acceptance.outcome) {
    case "accepted":
      return "accepted";
    case "rejected":
    case "accepted-with-caveats":
      return "accepted-with-caveats";
    case "unverified":
      return "unverified";
  }
}

function deriveAbandonedRoots(decision: TerminationStop | TerminationPlanExhausted): readonly string[] {
  if (decision.decision === "stop") return decision.abandonedRoots;
  return [];
}

export function buildRunSummary(input: RunSummaryInput, decision: TerminationStop | TerminationPlanExhausted): RunSummary {
  const byId = new Map(input.items.map((it) => [it.id, it] as const));
  const shipped = buildShipped(input.items);
  const abandoned = buildAbandoned(input.items);
  const stalledItems = decision.decision === "stop" ? decision.stalled : decision.stalled;
  const abandonedRoots = deriveAbandonedRoots(decision);
  const stopReason = deriveStopReason(decision, input.acceptance);
  const gapDecision: TerminationStop = decision.decision === "stop"
    ? decision
    : { decision: "stop", reason: decision.trigger, counts: decision.counts, stalled: stalledItems, abandonedRoots: [...abandonedRoots] };
  const gaps = buildGaps(input.items, gapDecision, byId);
  const endpointGaps = input.endpointGaps ?? [];

  const runItems = input.items.filter((it) => it.runScope === input.currentRunScope);
  const runShipped = buildShipped(runItems);
  const runAbandoned = buildAbandoned(runItems);
  const outOfScope = classifyOutOfScope(input.items, input.currentRunScope);

  const narrative = buildNarrative(
    stopReason,
    decision.counts,
    runShipped,
    runAbandoned,
    gaps,
    endpointGaps,
    outOfScope,
    input.acceptance,
    input.completionFigure,
  );

  const summary: RunSummary = {
    stopReason,
    counts: decision.counts,
    shipped,
    abandoned,
    gaps,
    endpointGaps,
    abandonedRoots: [...abandonedRoots],
    narrative,
    ...(input.completionFigure !== undefined ? { completionFigure: input.completionFigure } : {}),
  };
  if (input.acceptance !== undefined) {
    return { ...summary, acceptance: input.acceptance };
  }
  return summary;
}

export function emitRunSummary(logger: EventSink, summary: RunSummary): RunSummary {
  logger.emit({
    event: "run_terminated",
    reason: summary.stopReason,
    counts: summary.counts,
    shippedCount: summary.shipped.length,
    abandonedCount: summary.abandoned.length,
    gapCount: summary.gaps.length,
    endpointGapCount: summary.endpointGaps.length,
    shipped: summary.shipped,
    abandoned: summary.abandoned,
    gaps: summary.gaps,
    endpointGaps: summary.endpointGaps,
    abandonedRoots: summary.abandonedRoots,
    completionFigure: summary.completionFigure,
    narrative: summary.narrative,
  });
  return summary;
}

function buildShipped(items: readonly RunSummaryItem[]): ShippedItem[] {
  return items
    .filter((it) => it.status === "Completed")
    .map((it) => ({ id: it.id, title: it.title, level: it.level }));
}

function buildAbandoned(items: readonly RunSummaryItem[]): AbandonedItem[] {
  return items.filter((it) => it.status === "Abandoned").map((it) => classifyAbandon(it));
}

function classifyAbandon(item: RunSummaryItem): AbandonedItem {
  // Widen through the exhaustive seam — a new source variant is a compile
  // error in blockedReasonToRecord, not a silent assignment to Record.
  // contract-erasing: StoredBlockedReason widened via blockedReasonToRecord for duck-typed access
  const raw: Record<string, unknown> = item.blockedReason
    ? blockedReasonToRecord(item.blockedReason)
    : {};
  const source = readString(raw, "source");

  if (source === "api") {
    return {
      id: item.id,
      title: item.title,
      level: item.level,
      kind: "unspecified-abandon",
      reason: describeApiAbandon(raw),
      raw,
    };
  }

  const reasonText = readString(raw, "reason");
  const substitutedBy = readString(raw, "substitutedBy");
  const attempts = readNumber(raw, "attempts");
  const lastFailureDetail = readFailureDetail(raw, "lastFailure");

  if (substitutedBy !== undefined) {
    return {
      id: item.id,
      title: item.title,
      level: item.level,
      kind: "substitute-abandon",
      reason: `Superseded by equivalent item ${substitutedBy}${reasonText ? ` — ${reasonText}` : ""}.`,
      substitutedBy,
      attempts,
      lastFailureDetail,
      raw,
    };
  }

  if (reasonText !== undefined) {
    const attemptsNote = attempts !== undefined ? ` after ${attempts} attempt(s)` : "";
    const failureNote = lastFailureDetail !== undefined ? `; last failure: ${lastFailureDetail}` : "";
    return {
      id: item.id,
      title: item.title,
      level: item.level,
      kind: "exhausted-abandon",
      reason: `${reasonText}${attemptsNote}${failureNote}.`,
      attempts,
      lastFailureDetail,
      raw,
    };
  }

  return {
    id: item.id,
    title: item.title,
    level: item.level,
    kind: "unspecified-abandon",
    reason: describeUnspecified(raw),
    raw,
  };
}

// contract-erasing: navigates widened StoredBlockedReason fields by string key
function describeUnspecified(raw: Record<string, unknown>): string {
  const note = readString(raw, "note");
  if (note !== undefined) return `Abandoned: ${note}`;
  const keys = Object.keys(raw);
  if (keys.length === 0) return "Abandoned with no recorded reason.";
  return `Abandoned with an unrecognized reason payload (keys: ${keys.join(", ")}).`;
}

// contract-erasing: navigates widened StoredBlockedReason (api variant) fields by string key
function describeApiAbandon(raw: Record<string, unknown>): string {
  const reasonText = readString(raw, "reason");
  if (reasonText !== undefined) return `Abandoned via API: ${reasonText}`;
  const note = readString(raw, "note");
  if (note !== undefined) return `Abandoned via API: ${note}`;
  const keys = Object.keys(raw).filter((k) => k !== "source");
  if (keys.length === 0) return "Abandoned via API with no recorded reason.";
  return `Abandoned via API with an unrecognized reason payload (keys: ${keys.join(", ")}).`;
}

function buildGaps(
  items: readonly RunSummaryItem[],
  decision: TerminationStop,
  byId: ReadonlyMap<string, RunSummaryItem>,
): CoverageGap[] {
  if (decision.reason === "completeness") return [];

  if (decision.reason === "liveness") {
    return decision.stalled.map((s) => ({
      id: s.id,
      title: byId.get(s.id)?.title ?? s.id,
      level: s.level,
      status: s.status,
      kind: "stalled",
      cause: s.cause,
      blockedBy: s.blockedBy,
      reason: describeStalled(s.cause, s.blockedBy, byId),
    }));
  }

  // Filter to unsettled items: items that are NOT Completed or Abandoned.
  // Uses explicit status checks rather than TERMINAL_STATUSES because Completed
  // is no longer graph-terminal (it has a reopen edge) but IS settled for the
  // purpose of identifying budget-cutoff gaps.
  return items
    .filter((it) => it.status !== "Completed" && it.status !== "Abandoned")
    .map((it) => ({
      id: it.id,
      title: it.title,
      level: it.level,
      status: it.status,
      kind: "budget-cutoff",
      blockedBy: [],
      reason: `Budget exhausted before this item could be completed (status: ${it.status}).`,
    }));
}

function describeStalled(
  cause: StalledCause,
  blockedBy: readonly string[],
  byId: ReadonlyMap<string, RunSummaryItem>,
): string {
  const names = blockedBy.map((id) => byId.get(id)?.title ?? id);
  switch (cause) {
    case "blocked_by_abandoned":
      return `Blocked by abandoned dependenc${names.length === 1 ? "y" : "ies"}: ${names.join(", ")}.`;
    case "stuck_failed":
      return "Stuck at Failed with no recovery path — nothing will re-dispatch it.";
    case "externally_blocked":
      return "Externally blocked (Blocked status) — requires a manual unblock.";
    case "cascade_frozen":
      return names.length > 0
        ? `Cannot cascade-complete: abandoned descendant(s) ${names.join(", ")} can never settle it.`
        : "Cannot cascade-complete: a descendant reached a non-Completed terminal state.";
    case "stalled_waiting":
      return "Waiting on an upstream item that is itself frozen.";
  }
}

/** Breakdown of items on the board that were NOT created by this run. */
interface OutOfScopeCounts {
  readonly total: number;
  readonly preScopingCount: number;
  readonly adHocCount: number;
  readonly otherRunCount: number;
}

/**
 * Partitions items NOT belonging to the current run into pre-scoping, ad-hoc,
 * and other-run buckets. Every item on the board appears in exactly one
 * partition (this-run or one of the three below).
 */
function classifyOutOfScope(items: readonly RunSummaryItem[], currentRunScope: string): OutOfScopeCounts {
  let preScopingCount = 0;
  let adHocCount = 0;
  let otherRunCount = 0;

  for (const item of items) {
    if (item.runScope === currentRunScope) continue;
    if (item.runScope === RUN_SCOPE_PRE_SCOPING) preScopingCount++;
    else if (item.runScope === RUN_SCOPE_AD_HOC) adHocCount++;
    else otherRunCount++;
  }

  return {
    total: preScopingCount + adHocCount + otherRunCount,
    preScopingCount,
    adHocCount,
    otherRunCount,
  };
}

function buildNarrative(
  reason: StopReason,
  counts: TerminationCounts,
  runShipped: readonly ShippedItem[],
  runAbandoned: readonly AbandonedItem[],
  gaps: readonly CoverageGap[],
  endpointGaps: readonly EndpointCoverageGap[],
  outOfScope: OutOfScopeCounts,
  acceptance?: AcceptanceVerdict,
  completionFigure?: CompletionFigure,
): string {
  const headlineMap: Record<StopReason, string> = {
    economy: "Run stopped because the budget was exhausted while dispatchable work remained.",
    accepted: "Run completed — vision acceptance check confirmed all requirements are met.",
    "accepted-with-caveats": "Run completed with caveats — some gaps remain but the acceptance iteration cap was reached.",
    // Says "did not confirm" rather than "never produced a verdict": a check can now
    // be PARTLY complete — one tier ran, the other could not — and claiming nothing
    // ran would be its own inaccuracy. The Cause clause carries which.
    unverified:
      "Run stopped UNVERIFIED — the plan was exhausted but the acceptance check did not confirm the vision was met, so nothing validates this output. Treat it as unvalidated.",
  };
  const unverifiedReason = acceptance?.unverifiedReason;
  const headline =
    unverifiedReason !== undefined && reason === "unverified"
      ? `${headlineMap[reason]} Cause: ${unverifiedReason}.`
      : headlineMap[reason];

  // Run-scoped shipped/abandoned — "This run" is load-bearing: it is what
  // makes the sentence falsifiable against a specific scope rather than
  // ambiguously true of the board.
  const shippedNote = `This run shipped ${runShipped.length} item(s).`;
  const abandonedNote =
    runAbandoned.length > 0
      ? ` This run abandoned ${runAbandoned.length} item(s) (${summarizeKinds(runAbandoned)}).`
      : "";

  const gapsNote =
    gaps.length > 0
      ? ` ${gaps.length} coverage gap(s) left undone: ${gaps.map((g) => `${g.title} (${g.reason})`).join(" ")}`
      : " No coverage gaps.";
  const endpointGapsNote =
    endpointGaps.length > 0
      ? ` ${endpointGaps.length} declared endpoint(s) still uncovered: ${endpointGaps
          .map((g) => `${g.method} ${g.path}`)
          .join(", ")}.`
      : "";
  // Acceptance findings were previously carried only in the structured summary, so
  // the one line an owner actually reads could name coverage gaps while staying
  // silent about the vision requirements the check itself found unmet.
  const acceptanceNote =
    acceptance !== undefined && acceptance.gaps.length > 0
      ? ` Acceptance found ${acceptance.gaps.length} unmet vision requirement(s): ${acceptance.gaps
          .map((g) => g.expected)
          .join("; ")}.`
      : "";

  // Out-of-scope items: silence about them is how the original defect read as
  // success — the four "shipped" items included three from prior runs, and the
  // sentence did not say so.
  const outOfScopeNote = buildOutOfScopeNote(outOfScope);
  const completionNote = formatCompletionFigure(completionFigure);

  return `${headline} ${shippedNote}${abandonedNote}${gapsNote}${endpointGapsNote}${acceptanceNote}${outOfScopeNote}${completionNote} (board total=${counts.total}, nonTerminal=${counts.nonTerminal}).`;
}

function buildOutOfScopeNote(outOfScope: OutOfScopeCounts): string {
  if (outOfScope.total === 0) return "";

  const parts: string[] = [];
  if (outOfScope.preScopingCount > 0)
    parts.push(`${outOfScope.preScopingCount} pre-scoping`);
  if (outOfScope.adHocCount > 0)
    parts.push(`${outOfScope.adHocCount} ad-hoc`);
  if (outOfScope.otherRunCount > 0)
    parts.push(`${outOfScope.otherRunCount} from other runs`);

  return ` ${outOfScope.total} item(s) on the board were created outside this run (${parts.join(", ")}).`;
}

function summarizeKinds(abandoned: readonly AbandonedItem[]): string {
  const tally: Record<AbandonKind, number> = {
    "exhausted-abandon": 0,
    "substitute-abandon": 0,
    "unspecified-abandon": 0,
  };
  for (const item of abandoned) tally[item.kind] += 1;

  const parts: string[] = [];
  if (tally["exhausted-abandon"] > 0) parts.push(`${tally["exhausted-abandon"]} exhausted`);
  if (tally["substitute-abandon"] > 0) parts.push(`${tally["substitute-abandon"]} substituted`);
  if (tally["unspecified-abandon"] > 0) parts.push(`${tally["unspecified-abandon"]} unspecified`);
  return parts.join(", ");
}

// open-by-design: generic type guard — narrows unknown to Record as a stepping stone
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// contract-erasing: accessor for widened Record fields that were originally typed
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

// contract-erasing: accessor for widened Record fields that were originally typed
function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

// contract-erasing: accessor for widened Record fields that were originally typed
function readFailureDetail(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (!isRecord(value)) return undefined;
  return readString(value, "detail");
}

import type { WorkItemStatus } from "@ashara/shared";
import type { TerminationCounts, TerminationStop, StalledCause, StopReason, TerminationPlanExhausted } from "../termination.js";
import type { RunSummary, ShippedItem, AbandonedItem, AbandonKind, CoverageGap, EndpointCoverageGap } from "../run-summary.js";
import type { AcceptanceVerdict } from "../acceptance.js";

import type { TerminationItemSnapshot } from "./termination.js";
import type { EventSink } from "./ports.js";

export interface RunSummaryItem extends TerminationItemSnapshot {
  readonly title: string;
  readonly blockedReason?: Record<string, unknown>;
}

export interface RunSummaryInput {
  readonly items: readonly RunSummaryItem[];
  readonly endpointGaps?: readonly EndpointCoverageGap[];
  readonly acceptance?: AcceptanceVerdict;
}

const TERMINAL_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>([
  "Completed",
  "Abandoned",
  "Archived",
]);

export type RunSummaryDecision = TerminationStop | (TerminationPlanExhausted & { readonly stopReason: StopReason; readonly abandonedRoots?: readonly string[] });

function deriveStopReason(decision: TerminationStop | TerminationPlanExhausted, acceptance?: AcceptanceVerdict): StopReason {
  if (decision.decision === "stop") return decision.reason as StopReason;
  if (acceptance?.outcome === "accepted") return "accepted";
  if (acceptance?.outcome === "accepted-with-caveats") return "accepted-with-caveats";
  return "accepted";
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
  const narrative = buildNarrative(stopReason, decision.counts, shipped, abandoned, gaps, endpointGaps);

  const summary: RunSummary = {
    stopReason,
    counts: decision.counts,
    shipped,
    abandoned,
    gaps,
    endpointGaps,
    abandonedRoots: [...abandonedRoots],
    narrative,
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
  const raw = item.blockedReason ?? {};
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

function describeUnspecified(raw: Record<string, unknown>): string {
  const note = readString(raw, "note");
  if (note !== undefined) return `Abandoned: ${note}`;
  const keys = Object.keys(raw);
  if (keys.length === 0) return "Abandoned with no recorded reason.";
  return `Abandoned with an unrecognized reason payload (keys: ${keys.join(", ")}).`;
}

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

  return items
    .filter((it) => !TERMINAL_STATUSES.has(it.status))
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

function buildNarrative(
  reason: StopReason,
  counts: TerminationCounts,
  shipped: readonly ShippedItem[],
  abandoned: readonly AbandonedItem[],
  gaps: readonly CoverageGap[],
  endpointGaps: readonly EndpointCoverageGap[],
): string {
  const headlineMap: Record<StopReason, string> = {
    economy: "Run stopped because the budget was exhausted while dispatchable work remained.",
    accepted: "Run completed — vision acceptance check confirmed all requirements are met.",
    "accepted-with-caveats": "Run completed with caveats — some gaps remain but the acceptance iteration cap was reached.",
  };
  const headline = headlineMap[reason];

  const shippedNote = `${shipped.length} item(s) shipped (Completed).`;
  const abandonedNote =
    abandoned.length > 0 ? ` ${abandoned.length} item(s) abandoned (${summarizeKinds(abandoned)}).` : "";
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

  return `${headline} ${shippedNote}${abandonedNote}${gapsNote}${endpointGapsNote} (total=${counts.total}, nonTerminal=${counts.nonTerminal}).`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function readFailureDetail(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (!isRecord(value)) return undefined;
  return readString(value, "detail");
}

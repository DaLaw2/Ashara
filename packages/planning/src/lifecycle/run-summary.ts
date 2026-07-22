import type { WorkItemStatus } from "@ashara/shared";
import type { TerminationReason, TerminationCounts, TerminationStop, StalledCause } from "../termination.js";
import type { RunSummary, ShippedItem, AbandonedItem, AbandonKind, CoverageGap, EndpointCoverageGap } from "../run-summary.js";

import type { TerminationItemSnapshot } from "./termination.js";
import type { EventSink } from "./ports.js";

export interface RunSummaryItem extends TerminationItemSnapshot {
  readonly title: string;
  readonly blockedReason?: Record<string, unknown>;
}

export interface RunSummaryInput {
  readonly items: readonly RunSummaryItem[];
  readonly endpointGaps?: readonly EndpointCoverageGap[];
}

const TERMINAL_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>([
  "Completed",
  "Abandoned",
  "Archived",
]);

export function buildRunSummary(input: RunSummaryInput, decision: TerminationStop): RunSummary {
  const byId = new Map(input.items.map((it) => [it.id, it] as const));
  const shipped = buildShipped(input.items);
  const abandoned = buildAbandoned(input.items);
  const gaps = buildGaps(input.items, decision, byId);
  const endpointGaps = input.endpointGaps ?? [];
  const narrative = buildNarrative(decision.reason, decision.counts, shipped, abandoned, gaps, endpointGaps);

  return {
    stopReason: decision.reason,
    counts: decision.counts,
    shipped,
    abandoned,
    gaps,
    endpointGaps,
    abandonedRoots: decision.abandonedRoots,
    narrative,
  };
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
  reason: TerminationReason,
  counts: TerminationCounts,
  shipped: readonly ShippedItem[],
  abandoned: readonly AbandonedItem[],
  gaps: readonly CoverageGap[],
  endpointGaps: readonly EndpointCoverageGap[],
): string {
  const headline =
    reason === "completeness"
      ? "Run stopped because every planned item reached a terminal state."
      : reason === "economy"
        ? "Run stopped because the budget was exhausted while dispatchable work remained."
        : "Run stopped because the plan is frozen — no remaining item can make progress on its own.";

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

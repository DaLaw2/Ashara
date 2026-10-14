import { PROJECT_BLOCK_KINDS } from "@ashara/db";
import { EXECUTION_STATUSES } from "@ashara/development";
import { BLOCKED_REASON_SOURCES, OUTBOUND_TRANSITIONS, PROJECT_STATUSES, WORK_ITEM_STATUSES } from "@ashara/shared";
import type { WorkItemStatus } from "@ashara/shared";
import { APPLICABLE_FAULTS, SEAM_KINDS } from "./faults.js";
import type { FaultRecord } from "./faults.js";
import { sourceOf } from "./invariants.js";
import type { Snapshot } from "./invariants.js";

/**
 * What a run reached, against the code's own iterable lifecycle lists (design §4.12, S7): every
 * work-item transition, blocked-reason source, project status, project block kind and execution
 * status, and every fault kind at every seam.
 */
export interface Coverage {
  readonly transitions: Set<string>;
  readonly blockedSources: Set<string>;
  readonly projectStatuses: Set<string>;
  readonly blockKinds: Set<string>;
  readonly executionStatuses: Set<string>;
  readonly faults: Set<string>;
  /** What the batch of two reached (CONCURRENCY), recorded by the run as its interleaver reports it. */
  readonly concurrency: Set<string>;
}

/**
 * - batch-of-two: a cycle dispatched two tasks at once;
 * - turn-handed-on: a task gave the turn to the other at a seam call;
 * - contended:<wait>: a task waited on the other's checkout lock or spend-cap admission (F11).
 */
const CONCURRENCY = ["batch-of-two", "turn-handed-on", "contended:target-checkout", "contended:spend-admission"] as const;

export function emptyCoverage(): Coverage {
  return {
    transitions: new Set(),
    blockedSources: new Set(),
    projectStatuses: new Set(),
    blockKinds: new Set(),
    executionStatuses: new Set(),
    faults: new Set(),
    concurrency: new Set(),
  };
}

const COVERAGE_KEYS = [
  "transitions",
  "blockedSources",
  "projectStatuses",
  "blockKinds",
  "executionStatuses",
  "faults",
  "concurrency",
] as const satisfies ReadonlyArray<keyof Coverage>;

export function mergeCoverage(into: Coverage, from: Coverage): void {
  for (const key of COVERAGE_KEYS) for (const value of from[key]) into[key].add(value);
}

/** The status each domain event moves its item to; null for an event that is no transition. */
const EVENT_TARGET: Readonly<Record<string, WorkItemStatus | null>> = {
  "work_item.started": "InProgress",
  "work_item.completed": "Completed",
  "work_item.failed": "Failed",
  "work_item.blocked": "Blocked",
  "work_item.unblocked": "Pending",
  "work_item.replanned": "Pending",
  "work_item.abandoned": "Abandoned",
  // giveUpWorkItem (W6), and the defect a failed acceptance sweep opens and gives up (W7).
  "work_item.given_up": "Abandoned",
  "work_item.superseded": "Abandoned",
  "work_item.requeued": "Pending",
  "work_item.reopened": "Pending",
  "work_item.awaiting_checks": "Pending",
  "work_item.awaiting_environment": "Pending",
  "work_item.created": null,
};

/** A work item's domain event EVENT_TARGET does not map: its transition, and every later one of the item, is unknown. */
class UnmodelledDomainEvent extends Error {
  constructor(
    readonly eventType: string,
    readonly workItemId: string,
    readonly seq: number,
  ) {
    super(`coverage: domain event ${eventType} (seq ${seq}) of work item ${workItemId} is not in EVENT_TARGET; model it before the run's transitions can be counted`);
    this.name = "UnmodelledDomainEvent";
  }
}

/**
 * The transitions the run's domain events record, each item starting at Pending. An event this
 * table does not know stops the run, so a new event kind cannot pass unmodelled.
 */
function transitionsOf(snapshot: Snapshot): Set<string> {
  const status = new Map<string, WorkItemStatus>();
  const taken = new Set<string>();
  for (const event of snapshot.events) {
    if (event.workItemId === null) continue;
    const to = Object.hasOwn(EVENT_TARGET, event.eventType) ? EVENT_TARGET[event.eventType] : undefined;
    if (to === undefined) throw new UnmodelledDomainEvent(event.eventType, event.workItemId, event.seq);
    if (to === null) continue;
    const from = status.get(event.workItemId) ?? "Pending";
    taken.add(`${from}->${to}`);
    status.set(event.workItemId, to);
  }
  return taken;
}

/** What one snapshot adds; `executions` are the statuses the run's routing evidence shows. */
export function sample(coverage: Coverage, snapshot: Snapshot, faults: readonly FaultRecord[], executions: Iterable<string>): void {
  for (const transition of transitionsOf(snapshot)) coverage.transitions.add(transition);
  for (const item of snapshot.items) {
    const source = sourceOf(item.blockedReason);
    if (source !== null) coverage.blockedSources.add(source);
  }
  coverage.projectStatuses.add(snapshot.project.status);
  for (const episode of snapshot.episodes) coverage.blockKinds.add(episode.kind);
  for (const fault of faults) coverage.faults.add(`${fault.seam}:${fault.fault}`);
  for (const status of executions) coverage.executionStatuses.add(status);
}

export interface MachineCoverage {
  readonly machine: string;
  readonly reached: readonly string[];
  readonly unreached: readonly string[];
}

const ALL_TRANSITIONS = WORK_ITEM_STATUSES.flatMap((from) => OUTBOUND_TRANSITIONS[from].map((to) => `${from}->${to}`));

/** Reached and never-reached members of every list, in the lists' own order. */
export function coverageReport(coverage: Coverage): MachineCoverage[] {
  const split = (machine: string, all: readonly string[], seen: ReadonlySet<string>): MachineCoverage => ({
    machine,
    reached: all.filter((member) => seen.has(member)),
    unreached: all.filter((member) => !seen.has(member)),
  });
  const faultPairs = SEAM_KINDS.flatMap((seam) => APPLICABLE_FAULTS[seam].map((fault) => `${seam}:${fault}`));
  return [
    split("work-item transitions (OUTBOUND_TRANSITIONS)", ALL_TRANSITIONS, coverage.transitions),
    split("blocked-reason sources", BLOCKED_REASON_SOURCES, coverage.blockedSources),
    split("project statuses", PROJECT_STATUSES, coverage.projectStatuses),
    split("project block kinds", PROJECT_BLOCK_KINDS, coverage.blockKinds),
    split("execution statuses (inferred from their routing)", EXECUTION_STATUSES, coverage.executionStatuses),
    split("faults by seam", faultPairs, coverage.faults),
    split("batch of two", CONCURRENCY, coverage.concurrency),
  ];
}

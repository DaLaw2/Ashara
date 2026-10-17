import { sql } from "drizzle-orm";
import { z } from "zod";
import { PROJECT_BLOCK_KINDS } from "@ashara/db";
import { EXECUTION_STATUSES, observeAcceptanceSweeps as observeQualitySweeps } from "@ashara/quality";
import type { AcceptanceSweep } from "@ashara/quality";
import { ATTEMPT_TERMINALS } from "@ashara/workplace";
import { BLOCKED_REASON_SOURCES, OUTBOUND_TRANSITIONS, WORK_ITEM_STATUSES } from "@ashara/delivery";
import { PROJECT_STATUSES } from "@ashara/engagement";
import type { WorkItemStatus } from "@ashara/delivery";
import type { Database } from "./database.js";
import { APPLICABLE_FAULTS, SEAM_KINDS } from "./faults.js";
import type { FaultRecord } from "./faults.js";
import { haltCauseOf, sourceOf } from "./invariants.js";
import type { Snapshot } from "./invariants.js";
import { MUTATIONS } from "./plants.js";

/**
 * What a run reached, against the code's own iterable lifecycle lists: every
 * work-item transition, blocked-reason source, project status, project block kind and execution
 * status, and every fault kind at every seam; every acceptance sweep outcome and every halt
 * by its cause and block kind.
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
  /** The acceptance sweeps' outcomes, recorded by the run as production returns them (observeAcceptanceSweeps). */
  readonly sweeps: Set<string>;
  /** Each halt reached, as `<cause>:<block kind>` (invariants.ts haltCauseOf). */
  readonly halts: Set<string>;
  /** The attempt terminals dev_sessions records (ATTEMPT_TERMINALS), read at the run's end. */
  readonly attempts: Set<string>;
  /** Each response-level misbehaviour as production recorded meeting it (MODEL_PATHS), read at the run's end. */
  readonly models: Set<string>;
  /** Each mutation whose seam the run reached (plants.ts): a query it would rewrite, or a wait it would skip. */
  readonly plants: Set<string>;
}

/**
 * Every outcome of an acceptance sweep, by the kind Quality returns (verification.ts
 * AcceptanceSweep): `satisfies` makes the type checker refuse this list when a kind is added or
 * removed there, so it cannot drift from the code's own union.
 */
const SWEEP_OUTCOMES = {
  ran: ["ran:passed", "ran:failed"],
  unrunnable: ["unrunnable"],
  faulted: ["faulted"],
} as const satisfies Record<AcceptanceSweep["kind"], readonly string[]>;

function sweepOutcome(sweep: AcceptanceSweep): string {
  return sweep.kind === "ran" ? (sweep.passed ? "ran:passed" : "ran:failed") : sweep.kind;
}

/**
 * Records the outcome of every acceptance sweep the run's instances return, through Quality's
 * declared observer (the sweep writes no record of an unrunnable sweep); returns what undoes it.
 */
export function observeAcceptanceSweeps(onSweep: (outcome: string) => void): () => void {
  return observeQualitySweeps((sweep) => onSweep(sweepOutcome(sweep)));
}

/**
 * - batch-of-two: a cycle dispatched two tasks at once;
 * - turn-handed-on: a task gave the turn to the other at a seam call;
 * - contended:<wait>: a task waited on the other's checkout lock or spend-cap admission.
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
    sweeps: new Set(),
    halts: new Set(),
    attempts: new Set(),
    models: new Set(),
    plants: new Set(),
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
  "sweeps",
  "halts",
  "attempts",
  "models",
  "plants",
] as const satisfies ReadonlyArray<keyof Coverage>;

const coverageSet = z.set(z.string());

/** A Coverage that crossed a process boundary (simulate.ts --jobs): read back, never trusted. */
export const CoverageSchema = z.strictObject({
  transitions: coverageSet,
  blockedSources: coverageSet,
  projectStatuses: coverageSet,
  blockKinds: coverageSet,
  executionStatuses: coverageSet,
  faults: coverageSet,
  concurrency: coverageSet,
  sweeps: coverageSet,
  halts: coverageSet,
  attempts: coverageSet,
  models: coverageSet,
  plants: coverageSet,
}) satisfies z.ZodType<Coverage>;

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
  // giveUpWorkItem: an open item given up, its cause on record; also the defect a failed acceptance sweep
  // opens and gives up.
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
  for (const episode of snapshot.episodes) {
    coverage.blockKinds.add(episode.kind);
    coverage.halts.add(`${haltCauseOf(episode.kind)}:${episode.kind}`);
  }
  for (const fault of faults) coverage.faults.add(`${fault.seam}:${fault.fault}`);
  for (const status of executions) coverage.executionStatuses.add(status);
}

/**
 * Every response-level misbehaviour the stand-ins can show (profile.ts), as production's records
 * show it was met, never as the stand-in says it misbehaved:
 * - turn:* / structured:*: an llm_calls row of an agent turn, or of a one-shot structured call,
 *   recorded cut at the output limit (finish reason length) with output beyond its reasoning, or with
 *   every output token reasoning; or recorded stopped with no output at all; or, structured, an
 *   error stopped with output (the answer did not parse or did not validate);
 * - merge:conflict-presented: a session's brief hands the task its conflict with main.
 */
const MODEL_PATHS = [
  "turn:truncated",
  "turn:reasoning-exhausted",
  "turn:empty",
  "structured:truncated",
  "structured:reasoning-exhausted",
  "structured:empty",
  "structured:invalid",
  "merge:conflict-presented",
] as const;
type ModelPath = (typeof MODEL_PATHS)[number];

/** The call site every agent turn is recorded under (workplace attempt.ts AGENT_CALL_SITE). */
const AGENT_CALL_SITE = "agent-runner";

const callRowSchema = z.object({
  callSite: z.string(),
  finishReason: z.string().nullable(),
  outcome: z.string().nullable(),
  outputTokens: z.number().int().nullable(),
  reasoningTokens: z.number().int().nullable(),
});
type CallRow = z.infer<typeof callRowSchema>;

/**
 * The misbehaviour one recorded llm_calls row shows it met, or null for a call answered as asked.
 * @testseam coverage.test.ts pins the path of each recorded shape
 */
export function modelPathOf(row: CallRow): ModelPath | null {
  const kind = row.callSite === AGENT_CALL_SITE ? "turn" : "structured";
  if (row.finishReason === "length") {
    const allReasoning = row.outputTokens !== null && row.outputTokens > 0 && row.reasoningTokens !== null && row.reasoningTokens >= row.outputTokens;
    return `${kind}:${allReasoning ? "reasoning-exhausted" : "truncated"}`;
  }
  if (row.finishReason === "stop" && row.outputTokens === 0) return `${kind}:empty`;
  if (kind === "structured" && row.finishReason === "stop" && row.outcome === "error") return "structured:invalid";
  return null;
}

const terminalRows = z.array(z.object({ terminal: z.string() }));
const countRow = z.tuple([z.object({ n: z.number().int() })]);
/** The heading an attempt's brief opens its conflict with main with (Quality's merge.ts formatConflictForBrief). */
const CONFLICT_BRIEF_HEADING = "## Merge with main in progress";

/** What the run's records show of attempts and model misbehaviour: read once, at the run's end, from its projects' rows. */
export async function sampleModelPaths(coverage: Coverage, observer: Database, projectIds: readonly string[]): Promise<void> {
  for (const projectId of projectIds) {
    const terminals = await observer.execute(sql`
      SELECT DISTINCT s.attempt_terminal AS terminal FROM dev_sessions s JOIN work_items w ON w.id = s.task_id
      WHERE w.project_id = ${projectId} AND s.attempt_terminal IS NOT NULL`);
    for (const row of terminalRows.parse(terminals.rows)) coverage.attempts.add(row.terminal);
    const calls = await observer.execute(sql`
      SELECT call_site AS "callSite", finish_reason AS "finishReason", outcome, output_tokens AS "outputTokens", reasoning_tokens AS "reasoningTokens"
      FROM llm_calls WHERE project_id = ${projectId} AND state = 'recorded'`);
    for (const row of z.array(callRowSchema).parse(calls.rows)) {
      const path = modelPathOf(row);
      if (path !== null) coverage.models.add(path);
    }
    const conflicts = await observer.execute(sql`
      SELECT count(*)::int AS n FROM dev_sessions s JOIN work_items w ON w.id = s.task_id
      WHERE w.project_id = ${projectId} AND strpos(s.brief::text, ${CONFLICT_BRIEF_HEADING}) > 0`);
    if (countRow.parse(conflicts.rows)[0].n > 0) coverage.models.add("merge:conflict-presented");
  }
}

interface MachineCoverage {
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
    split("acceptance sweeps (AcceptanceSweep kinds)", Object.values(SWEEP_OUTCOMES).flat(), coverage.sweeps),
    split("halts by cause (project block kinds)", PROJECT_BLOCK_KINDS.map((kind) => `${haltCauseOf(kind)}:${kind}`), coverage.halts),
    split("attempt terminals (ATTEMPT_TERMINALS)", ATTEMPT_TERMINALS, coverage.attempts),
    split("model misbehaviour met (MODEL_PATHS)", MODEL_PATHS, coverage.models),
    split("plant seams reached (MUTATIONS)", MUTATIONS, coverage.plants),
  ];
}

type BehaviourSet = "faults" | "models" | "concurrency" | "plants";

/**
 * The behaviour keys a soak counts (scripts/simulate.ts): every fault kind at every seam it applies
 * to, every response-level misbehaviour met, every contended wait and every plant's seam. Each is
 * forced directly by a test of the directed tier (simulator-faults.test.ts, simulator-plants.test.ts); the floor keeps the seeded
 * soak exploring it too, so a change that stops the soak reaching one is named, not silent.
 */
const BEHAVIOURS: ReadonlyArray<readonly [set: BehaviourSet, members: readonly string[]]> = [
  ["faults", SEAM_KINDS.flatMap((seam) => APPLICABLE_FAULTS[seam].map((fault) => `${seam}:${fault}`))],
  ["models", MODEL_PATHS],
  ["concurrency", CONCURRENCY],
  ["plants", MUTATIONS],
];

/**
 * The soaks that have a coverage floor, by the profile their seeds run under, and the sets each
 * floors. Under the seeds' own profiles (profile.ts profileOfSeed) a soak draws seam faults, and the
 * hostile and chaos profiles' misbehaviour at low rates. The adversarial profile draws no seam fault
 * (profile.ts FAULTS) and every misbehaviour at high rates, so it floors the model and concurrency
 * sets and no fault set.
 */
const FLOORS = {
  own: ["faults", "models", "concurrency", "plants"],
  adversarial: ["models", "concurrency"],
} as const satisfies Record<string, readonly BehaviourSet[]>;
export type Floor = keyof typeof FLOORS;

/**
 * The keys a soak under its seeds' own profiles reaches too seldom to floor, each with the seeds of
 * 400 that reached it: under 5% of seeds, so at 80 seeds each is expected under 4 times and is at
 * zero more than once in 55 soaks (e^-4), which a re-roll alone would cause, not a lost behaviour.
 * Every key at 5% or more is floored. Each key here is forced by the directed tier instead
 * (simulator-faults.test.ts), and every MODEL_PATHS key is floored in the adversarial soak.
 */
export const RARE_UNDER_OWN_PROFILES: ReadonlyMap<string, number> = new Map([
  ["faults db:db-unreachable", 1],
  ["faults podman:cell-start-failed", 14],
  ["faults podman:cell-exec-failed", 12],
  ["faults podman:cell-teardown-failed", 4],
  ["faults podman:substrate-down", 4],
  ["faults podman:image-build-failed", 1],
  ["faults model:crash-before", 17],
  ["faults model:sigterm", 12],
  ["faults model:provider-error", 15],
  ["faults model:clock-jump", 15],
  ["models turn:truncated", 16],
  ["models turn:empty", 8],
  ["models merge:conflict-presented", 0],
  ["plants stop-report-omits-merge", 8],
]);

/** How many seeds of a soak reached each behaviour key, every key present from zero, in BEHAVIOURS' order. */
export function emptyBehaviourCounts(): Map<string, number> {
  return new Map(BEHAVIOURS.flatMap(([set, members]) => members.map((member) => [`${set} ${member}`, 0] as const)));
}

/** One seed's coverage added to the counts. */
export function countBehaviours(counts: Map<string, number>, coverage: Coverage): void {
  for (const [set, members] of BEHAVIOURS) {
    for (const member of members) {
      if (!coverage[set].has(member)) continue;
      const key = `${set} ${member}`;
      // eslint-disable-next-line no-restricted-syntax -- policy default: a behaviour not yet counted has count 0, the accumulator's start
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
}

/** The floored keys no seed of the soak reached: each fails it. */
export function behavioursBelowFloor(counts: ReadonlyMap<string, number>, floor: Floor): string[] {
  const sets: readonly BehaviourSet[] = FLOORS[floor];
  return [...counts]
    .filter(([key, seeds]) => seeds === 0 && sets.some((set) => key.startsWith(`${set} `)) && !(floor === "own" && RARE_UNDER_OWN_PROFILES.has(key)))
    .map(([key]) => key);
}

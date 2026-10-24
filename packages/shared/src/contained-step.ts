import { systemClock, type Clock } from "./clock.js";
import { describeErrorChain } from "./error-chain.js";
import type { ProjectId } from "./ids.js";
import { createLogger } from "./log.js";
import type { Logger } from "./log.js";

// One subject's failure in a step of the contractor loop's cycle is that subject's: recorded on it,
// tried again after a backoff, and logged at warn, while the step goes on with every other subject.
// A step that let it throw would stop the cycle for every project, cycle after cycle. That holds for
// reading a subject as much as for acting on it: a listing reads each subject's rows on their own
// (readEach), so a row that cannot be read is its subject's fault, never the listing's. A subject that
// keeps failing halts its project, blamed on whose failure its last fault was (the containment's halt
// reads it with the one classifier of a failed model call), so it reaches the client's report and the
// owner's unblock, and is parked: never tried again while its project is not at work, so a subject
// of a project already halted, stopped or accepted ends on its record instead of retrying unseen.

/**
 * The steps of a cycle that work through their subjects one at a time, each subject one project's.
 * Engagement's and Organization's steps are named here beside Delivery's, and Organization may not
 * import Delivery, so the list is the kernel's.
 */
export type CycleStep =
  | "liaison-intake"
  | "liaison-answers"
  | "roster"
  | "first-plan"
  | "replan"
  | "plan-report"
  | "plan-revision-report"
  | "block-report"
  | "terminal-report"
  | "burn-warning"
  | "stack-choice"
  | "client-stop"
  | "client-change"
  | "client-receipt"
  | "acceptance"
  | "terminal-sweep"
  | "gate"
  | "parked-exits"
  | "infrastructure-resume"
  | "client-wait-resume";

/**
 * A subject with a fault on record: how many in a row, and whether it is tried again now (its
 * backoff has passed and, when it is parked, its project is back at work).
 */
export interface StepFaultStanding {
  readonly faults: number;
  readonly due: boolean;
}

/** Where a step's faults are kept per subject, so a backoff outlives the process that set it. */
export interface StepFaultLedger {
  /** Every subject of `step` with a fault on record. */
  faultsOf(step: CycleStep): Promise<ReadonlyMap<string, StepFaultStanding>>;
  /** One more fault on the subject, with its error and when it is tried again; returns the count after it. */
  record(fault: {
    readonly step: CycleStep;
    readonly subjectId: string;
    readonly projectId: ProjectId;
    readonly error: string;
    readonly retryAfterSeconds: number;
  }): Promise<number>;
  /** The subject ran through: its faults are cleared. */
  clear(step: CycleStep, subjectId: string): Promise<void>;
  /** The subject exhausted its faults: it is not due again while its project is not at work (an owner's unblock returns it). */
  park(step: CycleStep, subjectId: string): Promise<void>;
}

/** The ledger, with the errors the cycle itself handles and no step may contain, and the halt of a project whose subject keeps failing. */
export interface StepContainment extends StepFaultLedger {
  /** An error the cycle handles for every subject at once (a spend-cap refusal): it throws through. */
  escapes(error: unknown): boolean;
  /**
   * Halts the project (Delivery's halt) under whose failure the subject's last fault was, read
   * from the fault's cause (its last error) by the one classifier of a failed model call: the model's,
   * its provider's, or Ashara's own. A project already halted keeps its first cause, and one stopped
   * or accepted is not halted: either is "already-blocked".
   */
  halt(projectId: ProjectId, fault: StepFaultsExhausted): Promise<"blocked" | "already-blocked">;
  /** The logger each subject's run is scoped on (its project and subject), so every record of the run names them. */
  readonly logger: Logger;
}

/** Faults in a row after which a subject's project is halted: with the backoff below, about an hour of failing. */
const MAX_SUBJECT_FAULTS = 6;

/**
 * A subject of a cycle step failed MAX_SUBJECT_FAULTS times in a row or more: its project halts. Its
 * cause is the last fault's error, so the halt is blamed on whose failure that was, never assumed.
 */
class StepFaultsExhausted extends Error {
  constructor(
    readonly step: CycleStep,
    readonly subjectId: string,
    readonly faults: number,
    readonly lastError: string,
    options: { readonly cause: unknown },
  ) {
    super(`step ${step} failed on ${subjectId} ${faults} times in a row (step_faults); the last: ${lastError}`, options);
    this.name = "StepFaultsExhausted";
  }
}

/** A subject whose run failed this cycle: recorded, and tried again after `retryAfterSeconds`. */
export interface StepFaulted {
  readonly kind: "step-faulted";
  readonly step: CycleStep;
  readonly subjectId: string;
  readonly projectId: ProjectId;
  readonly faults: number;
  readonly retryAfterSeconds: number;
  readonly error: string;
}

/**
 * @testseam The wait before a subject is tried again after its first fault; each fault in a row
 * after it doubles the wait. A cross-package test holds the simulator's settle cycles to it.
 */
export const FIRST_FAULT_BACKOFF_SECONDS = 60;

/** The wait before a subject is tried again after its `faults`-th fault in a row: doubling from the first, at most an hour. */
export function faultBackoffSeconds(faults: number): number {
  return Math.min(FIRST_FAULT_BACKOFF_SECONDS * 2 ** Math.max(0, faults - 1), 3600);
}

/** The subject of a step a listing names: its id in the step's ledger, and the project it is one of. */
interface StepSubject {
  readonly id: string;
  readonly projectId: ProjectId;
}

/**
 * A subject a listing named and could not read, with what reading its rows threw. containEach
 * records it on the subject as it records a run that threw, so the listing still yields every other
 * subject.
 */
export class UnreadSubject implements StepSubject {
  constructor(
    readonly id: string,
    readonly projectId: ProjectId,
    readonly error: unknown,
  ) {}
}

/**
 * Reads each row of a listing of many projects' subjects on its own: a row whose `read` throws becomes
 * its subject's UnreadSubject, and every other row is still read; a row already unread is kept as it
 * is. `subjectOf` names the subject as the step's containEach does, so its fault and the clearing of
 * it land on one subject, from only what the listing's own query yields.
 */
export async function readEach<R, T>(
  rows: ReadonlyArray<R | UnreadSubject>,
  subjectOf: (row: R) => StepSubject,
  read: (row: R) => Promise<T> | T,
): Promise<Array<T | UnreadSubject>> {
  const listed: Array<T | UnreadSubject> = [];
  for (const row of rows) {
    if (row instanceof UnreadSubject) {
      listed.push(row);
      continue;
    }
    try {
      listed.push(await read(row));
    } catch (err) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the failed read is kept as its subject's UnreadSubject, which the step reports as that subject's fault
      const subject = subjectOf(row);
      listed.push(new UnreadSubject(subject.id, subject.projectId, err));
    }
  }
  return listed;
}

type SubjectRun<O> = { readonly ran: true; readonly outcome: O } | { readonly ran: false; readonly error: unknown };

async function runSubject<T, O>(item: T | UnreadSubject, run: (item: T) => Promise<O>): Promise<SubjectRun<O>> {
  if (item instanceof UnreadSubject) return { ran: false, error: item.error };
  try {
    return { ran: true, outcome: await run(item) };
  } catch (err) {
    return { ran: false, error: err };
  }
}

/**
 * Runs `run` on each item in order, each contained to its subject: a subject waiting out the backoff
 * of an earlier fault, or parked while its project is not at work, is skipped; a run that throws
 * anything but an escaping error, and a subject its listing could not read (UnreadSubject), is
 * recorded on the subject and logged at warn, and the next item runs. Once a subject's faults in a
 * row reach MAX_SUBJECT_FAULTS its project is halted and the subject parked, logged at error. A run
 * that completes clears the subject's faults. Only an escaping error, or a failure of the ledger or
 * of the halt itself, throws through.
 */
export async function containEach<T, O>(
  containment: StepContainment,
  step: CycleStep,
  items: ReadonlyArray<T | UnreadSubject>,
  subjectOf: (item: T) => StepSubject,
  run: (item: T) => Promise<O>,
): Promise<Array<O | StepFaulted>> {
  if (items.length === 0) return [];
  const standing = await containment.faultsOf(step);
  const outcomes: Array<O | StepFaulted> = [];
  for (const item of items) {
    const subject = item instanceof UnreadSubject ? item : subjectOf(item);
    const prior = standing.get(subject.id);
    if (prior !== undefined && !prior.due) continue;
    outcomes.push(
      await containment.logger.scope({ projectId: subject.projectId, subject: subject.id }, () =>
        containSubject({ containment, step, item, subject, prior, run }),
      ),
    );
  }
  return outcomes;
}

/** One subject's run, contained to it: its outcome, or its recorded fault. Only an escaping error, or a ledger's failure, throws. */
async function containSubject<T, O>({ containment, step, item, subject, prior, run }: {
  readonly containment: StepContainment;
  readonly step: CycleStep;
  readonly item: T | UnreadSubject;
  readonly subject: StepSubject;
  readonly prior: StepFaultStanding | undefined;
  readonly run: (item: T) => Promise<O>;
}): Promise<O | StepFaulted> {
  const result = await runSubject(item, run);
  if (result.ran) {
    // A run that completes clears the faults "in a row", so a subject whose runs
    // alternate fault and success never halts here. That is a deliberate wait, not a work loop:
    // containEach sends no model request of its own and backs every fault off, a minute doubling
    // to an hour; every model request a subject's run sends draws from the work ledger, which
    // ends the subject's paid work when its project's budget is spent.
    if (prior !== undefined) await containment.clear(step, subject.id);
    return result.outcome;
  }
  if (containment.escapes(result.error)) throw result.error;
  const error = describeErrorChain(result.error);
  // eslint-disable-next-line no-restricted-syntax -- policy default: no standing on the ledger is a subject with no fault in a row, so this fault is its first
  const retryAfterSeconds = faultBackoffSeconds((prior?.faults ?? 0) + 1);
  const faults = await containment.record({ step, subjectId: subject.id, projectId: subject.projectId, error, retryAfterSeconds });
  const where = `[${step}] ${subject.id} (project ${subject.projectId}): fault ${faults} in a row`;
  if (faults >= MAX_SUBJECT_FAULTS) {
    const halted = await containment.halt(subject.projectId, new StepFaultsExhausted(step, subject.id, faults, error, { cause: result.error }));
    await containment.park(step, subject.id);
    const project =
      halted === "blocked" ? "its project is now halted, under whose failure this last fault was" : "its project was already halted, stopped or accepted, and keeps its first cause";
    console.error(
      `${where}; ${project}; the subject is parked in step_faults and not tried again until its project is back at work ` +
        `(npx tsx scripts/project.ts unblock ${subject.projectId} --reason <what was repaired>); the step goes on with its other subjects: ${error}`,
    );
  } else {
    console.warn(`${where}, tried again in ${retryAfterSeconds}s; the step goes on with its other subjects: ${error}`);
  }
  return { kind: "step-faulted", step, subjectId: subject.id, projectId: subject.projectId, faults, retryAfterSeconds, error };
}

/**
 * A ledger held in memory, for a step under test.
 * Unit tests of the cycle's steps, and the inert loop they build, contain their subjects with it; the composition root supplies db's ledger.
 * A backoff is set and judged on `clock`; a test that moves time past one passes the clock it moves.
 */
export function memoryStepContainment(escapes: (error: unknown) => boolean, clock: Clock = systemClock): StepContainment & {
  readonly recorded: ReadonlyMap<string, { readonly faults: number; readonly error: string; readonly retryAt: number; readonly parked: boolean }>;
  readonly halted: ReadonlyArray<{ readonly projectId: ProjectId; readonly fault: StepFaultsExhausted }>;
  /** The projects not at work: a halt of one is "already-blocked", and a parked subject of one is not due. */
  readonly notAtWork: Set<ProjectId>;
} {
  const recorded = new Map<string, { faults: number; error: string; retryAt: number; parked: boolean; projectId: ProjectId }>();
  const halted: Array<{ projectId: ProjectId; fault: StepFaultsExhausted }> = [];
  const notAtWork = new Set<ProjectId>();
  const key = (step: CycleStep, subjectId: string): string => `${step}/${subjectId}`;
  return {
    // A test of a step's outcomes reads none of its records; one that does supplies its own logger.
    logger: createLogger({ sink: { write: () => undefined }, clock: systemClock, minLevel: "error" }),
    recorded,
    halted,
    notAtWork,
    escapes,
    halt: async (projectId, fault) => {
      if (notAtWork.has(projectId)) return "already-blocked";
      halted.push({ projectId, fault });
      notAtWork.add(projectId);
      return "blocked";
    },
    faultsOf: async (step) => {
      const prefix = `${step}/`;
      const standing = new Map<string, StepFaultStanding>();
      for (const [at, fault] of recorded) {
        const due = fault.retryAt <= clock.now() && !(fault.parked && notAtWork.has(fault.projectId));
        if (at.startsWith(prefix)) standing.set(at.slice(prefix.length), { faults: fault.faults, due });
      }
      return standing;
    },
    record: async (fault) => {
      const prior = recorded.get(key(fault.step, fault.subjectId));
      recorded.set(key(fault.step, fault.subjectId), {
        // eslint-disable-next-line no-restricted-syntax -- policy default: no prior entry is a subject with no fault in a row, so this fault is its first
        faults: (prior?.faults ?? 0) + 1,
        error: fault.error,
        retryAt: clock.now() + fault.retryAfterSeconds * 1000,
        // eslint-disable-next-line no-restricted-syntax -- policy default: a subject with no prior fault has not been parked
        parked: prior?.parked ?? false,
        projectId: fault.projectId,
      });
      // eslint-disable-next-line no-restricted-syntax -- policy default: no prior entry is a subject with no fault in a row, so this fault is its first
      return (prior?.faults ?? 0) + 1;
    },
    clear: async (step, subjectId) => {
      recorded.delete(key(step, subjectId));
    },
    park: async (step, subjectId) => {
      const fault = recorded.get(key(step, subjectId));
      if (fault === undefined) throw new UnrecordedSubjectParked(step, subjectId);
      fault.parked = true;
    },
  };
}

/** A subject was parked with no fault on record to park. */
class UnrecordedSubjectParked extends Error {
  constructor(
    readonly step: CycleStep,
    readonly subjectId: string,
  ) {
    super(`step ${step} parked ${subjectId}, which has no fault on record`);
    this.name = "UnrecordedSubjectParked";
  }
}

/** A containment was asked to keep a fault where nothing may be contained. */
class UncontainedStepFault extends Error {
  constructor(readonly step: CycleStep, readonly subjectId: string) {
    super(`step ${step} was asked to contain a fault on ${subjectId}, where every error throws through`);
    this.name = "UncontainedStepFault";
  }
}

/**
 * A containment that contains nothing: no subject is skipped for a fault on record, and every error
 * throws through. For a run that must stop on its first failure and ignore any backoff kept in the
 * records it reads, such as a replay of a kept run's records.
 */
export function uncontainedSteps(logger: Logger): StepContainment {
  return {
    logger,
    escapes: () => true,
    faultsOf: async () => new Map(),
    record: async (fault) => {
      throw new UncontainedStepFault(fault.step, fault.subjectId);
    },
    clear: async (step, subjectId) => {
      throw new UncontainedStepFault(step, subjectId);
    },
    halt: async (_projectId, fault) => {
      throw new UncontainedStepFault(fault.step, fault.subjectId);
    },
    park: async (step, subjectId) => {
      throw new UncontainedStepFault(step, subjectId);
    },
  };
}

import { describeErrorChain } from "./error-chain.js";
import type { ProjectId } from "./ids.js";

// One subject's failure in a step of the contractor loop's cycle is that subject's: recorded on it,
// tried again after a backoff, and logged at warn, while the step goes on with every other subject.
// A step that let it throw would stop the cycle for every project, cycle after cycle. A subject that
// keeps failing halts its project as Ashara's own fault, so it reaches the client's report and the
// owner's unblock instead of retrying unseen for good.

/** The steps of a cycle that work through their subjects one at a time, each subject one project's. */
export type CycleStep =
  | "liaison-intake"
  | "liaison-answers"
  | "roster"
  | "first-plan"
  | "replan"
  | "plan-report"
  | "plan-revision-report"
  | "block-report"
  | "stack-choice"
  | "client-stop"
  | "client-change"
  | "acceptance"
  | "gate"
  | "parked-exits"
  | "infrastructure-resume";

/** A subject with a fault on record: how many in a row, and whether its backoff has passed. */
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
}

/** The ledger, with the errors the cycle itself handles and no step may contain, and the halt of a project whose subject keeps failing. */
export interface StepContainment extends StepFaultLedger {
  /** An error the cycle handles for every subject at once (a spend-cap refusal): it throws through. */
  escapes(error: unknown): boolean;
  /** Halts the project as Ashara's own fault (Delivery's halt, O3 c); a project already halted keeps its first cause. */
  halt(projectId: ProjectId, fault: StepFaultsExhausted): Promise<void>;
}

/** Faults in a row after which a subject's project is halted: with the backoff below, about an hour of failing. */
const MAX_SUBJECT_FAULTS = 6;

/** A subject of a cycle step failed MAX_SUBJECT_FAULTS times in a row or more: its project halts on Ashara's own fault. */
class StepFaultsExhausted extends Error {
  constructor(
    readonly step: CycleStep,
    readonly subjectId: string,
    readonly faults: number,
    readonly lastError: string,
  ) {
    super(`step ${step} failed on ${subjectId} ${faults} times in a row (step_faults); the last: ${lastError}`);
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

/** The wait before a subject is tried again after its `faults`-th fault in a row: doubling from a minute, at most an hour. */
function faultBackoffSeconds(faults: number): number {
  return Math.min(60 * 2 ** Math.max(0, faults - 1), 3600);
}

/**
 * Runs `run` on each item in order, each contained to its subject: a subject waiting out the backoff
 * of an earlier fault is skipped; a run that throws anything but an escaping error is recorded on
 * its subject and logged at warn, its project is halted once its faults in a row reach
 * MAX_SUBJECT_FAULTS, and the next item runs; a run that completes clears the subject's faults. Only
 * an escaping error, or a failure of the ledger or of the halt itself, throws through.
 */
export async function containEach<T, O>(
  containment: StepContainment,
  step: CycleStep,
  items: readonly T[],
  subjectOf: (item: T) => { readonly id: string; readonly projectId: ProjectId },
  run: (item: T) => Promise<O>,
): Promise<Array<O | StepFaulted>> {
  if (items.length === 0) return [];
  const standing = await containment.faultsOf(step);
  const outcomes: Array<O | StepFaulted> = [];
  for (const item of items) {
    const subject = subjectOf(item);
    const prior = standing.get(subject.id);
    if (prior !== undefined && !prior.due) continue;
    let outcome: O;
    try {
      outcome = await run(item);
    } catch (err) {
      if (containment.escapes(err)) throw err;
      const error = describeErrorChain(err);
      const retryAfterSeconds = faultBackoffSeconds((prior?.faults ?? 0) + 1);
      const faults = await containment.record({ step, subjectId: subject.id, projectId: subject.projectId, error, retryAfterSeconds });
      const exhausted = faults >= MAX_SUBJECT_FAULTS;
      if (exhausted) await containment.halt(subject.projectId, new StepFaultsExhausted(step, subject.id, faults, error));
      console.warn(
        `[${step}] ${subject.id} (project ${subject.projectId}): fault ${faults} in a row, tried again in ${retryAfterSeconds}s` +
          `${exhausted ? "; its project is halted on Ashara's own fault until the owner unblocks it" : ""}; ` +
          `the step goes on with its other subjects: ${error}`,
      );
      outcomes.push({ kind: "step-faulted", step, subjectId: subject.id, projectId: subject.projectId, faults, retryAfterSeconds, error });
      continue;
    }
    if (prior !== undefined) await containment.clear(step, subject.id);
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * A ledger held in memory, for a step under test.
 * @testseam unit tests of the cycle's steps contain their subjects with it; the composition root supplies db's ledger
 */
export function memoryStepContainment(escapes: (error: unknown) => boolean): StepContainment & {
  readonly recorded: ReadonlyMap<string, { readonly faults: number; readonly error: string; readonly retryAt: number }>;
  readonly halted: ReadonlyArray<{ readonly projectId: ProjectId; readonly fault: StepFaultsExhausted }>;
} {
  const recorded = new Map<string, { faults: number; error: string; retryAt: number }>();
  const halted: Array<{ projectId: ProjectId; fault: StepFaultsExhausted }> = [];
  const key = (step: CycleStep, subjectId: string): string => `${step}/${subjectId}`;
  return {
    recorded,
    halted,
    escapes,
    halt: async (projectId, fault) => {
      halted.push({ projectId, fault });
    },
    faultsOf: async (step) => {
      const prefix = `${step}/`;
      const standing = new Map<string, StepFaultStanding>();
      for (const [at, fault] of recorded) {
        if (at.startsWith(prefix)) standing.set(at.slice(prefix.length), { faults: fault.faults, due: fault.retryAt <= Date.now() });
      }
      return standing;
    },
    record: async (fault) => {
      const faults = (recorded.get(key(fault.step, fault.subjectId))?.faults ?? 0) + 1;
      recorded.set(key(fault.step, fault.subjectId), { faults, error: fault.error, retryAt: Date.now() + fault.retryAfterSeconds * 1000 });
      return faults;
    },
    clear: async (step, subjectId) => {
      recorded.delete(key(step, subjectId));
    },
  };
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
export function uncontainedSteps(): StepContainment {
  return {
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
  };
}

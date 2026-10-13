import { z } from "zod";
import { projectBlockCause } from "@ashara/shared";
import type { ProjectBlockCause, ProjectId } from "@ashara/shared";

// The stack the team chose in Sprint 0, made visible to the client (story s-platform-role-m1).
// Engagement owns the vision: the environment role's statement becomes an Inferred assumption in a
// new vision version (versions are append-only), and the Liaison, the only writer to the client,
// reports the choice once. Due choices are read from recorded outcomes, so one made before a
// crash is still reported after the restart.

/** A completed Sprint 0 task's statement whose project has not been told about it. */
interface DueStackChoice {
  readonly projectId: ProjectId;
  readonly taskId: string;
  readonly statement: string;
  /** The project's current vision, as stored; null when it has none. */
  readonly vision: { readonly version: number; readonly inferences: unknown } | null;
}

interface StackChoiceWrite {
  readonly projectId: ProjectId;
  readonly basedOnVersion: number;
  readonly inferences: readonly unknown[];
  readonly changeReason: string;
  readonly report: string;
}

/** Engagement's persistence port for stack choices. */
export interface StackChoiceStore {
  dueStackChoices(): Promise<readonly DueStackChoice[]>;
  /**
   * Posts the report and appends the vision version after `basedOnVersion` together, in one
   * transaction; a project already reported on gets nothing new.
   */
  recordStackChoice(write: StackChoiceWrite): Promise<"recorded" | "already-reported">;
  /** Blocks the project and records why; a project already blocked keeps its first cause. */
  blockProject(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

type StackChoiceOutcome =
  | { readonly kind: "recorded" | "already-reported"; readonly projectId: ProjectId; readonly visionVersion: number }
  /** The project's record cannot carry the assumption truthfully: nothing is posted and the project is blocked. */
  | { readonly kind: "project-blocked"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/** What the core loop asks of the Liaison after a Sprint 0 task has merged. */
export interface LiaisonStackChoices {
  runPending(): Promise<readonly StackChoiceOutcome[]>;
}

// Intake writes an array of keyed Inferred records. Any other shape (the map rows the deleted CLI
// path wrote) cannot take a keyed assumption without rewriting what the client was told.
const StoredInferencesSchema = z.array(
  z.looseObject({ key: z.string().min(1).optional(), statement: z.string().min(1), status: z.string().min(1) }),
);

/** The project's vision cannot take the stack choice as an Inferred assumption. */
class StackChoiceVisionUnusable extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly detail: string,
  ) {
    super(`project ${projectId}: the stack choice cannot be recorded as an assumption: ${detail}; no report is posted`);
    this.name = "StackChoiceVisionUnusable";
  }
}

const ASSUMPTION_KEY = /^A(\d+)$/;

/** The next free A<n> key after every key already in the vision. */
function nextAssumptionKey(inferences: readonly { readonly key?: string | undefined }[]): string {
  let highest = inferences.length;
  for (const inference of inferences) {
    const match = inference.key === undefined ? null : ASSUMPTION_KEY.exec(inference.key);
    if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]));
  }
  return `A${highest + 1}`;
}

/**
 * Plain words: what the team chose and why, in its own statement; what the environment's test covers,
 * stated here rather than trusted to the statement (t-env-test-scope); and how to say it does not fit.
 */
function stackChoiceReport(statement: string): string {
  return [
    `The team has set up this project's environment and chose how the project is built and tested:`,
    statement,
    `The environment's own test proves only that the toolchain builds and runs; it does not test the product. What each planned task delivers is verified by checks written for it before that task starts.`,
    `Work on the project now proceeds on this choice. If it does not fit what you need, send a change saying what should be different.`,
  ].join("\n\n");
}

export class StackChoiceReports implements LiaisonStackChoices {
  constructor(private readonly store: StackChoiceStore) {}

  /**
   * One project's unusable vision blocks that project, and the others are still reported on. Any
   * other failure, a store failure included, throws through and fails the cycle.
   */
  async runPending(): Promise<readonly StackChoiceOutcome[]> {
    const outcomes: StackChoiceOutcome[] = [];
    for (const due of await this.store.dueStackChoices()) {
      let write: StackChoiceWrite;
      try {
        write = this.compose(due);
      } catch (err) {
        if (!(err instanceof StackChoiceVisionUnusable)) throw err;
        const cause = projectBlockCause(err);
        const result = await this.store.blockProject(due.projectId, cause);
        console.warn(`[liaison-stack-choice] project ${due.projectId}: ${cause.errorClass}; project ${result}: ${cause.reason}`);
        outcomes.push({ kind: "project-blocked", projectId: due.projectId, cause });
        continue;
      }
      const kind = await this.store.recordStackChoice(write);
      outcomes.push({ kind, projectId: due.projectId, visionVersion: write.basedOnVersion + 1 });
    }
    return outcomes;
  }

  private compose(due: DueStackChoice): StackChoiceWrite {
    if (due.vision === null) throw new StackChoiceVisionUnusable(due.projectId, "the project has no vision");
    const parsed = StoredInferencesSchema.safeParse(due.vision.inferences);
    if (!parsed.success) {
      throw new StackChoiceVisionUnusable(
        due.projectId,
        `vision v${due.vision.version} inferences are not a list of Inferred records: ${z.prettifyError(parsed.error)}`,
      );
    }
    const assumption = {
      key: nextAssumptionKey(parsed.data),
      statement: due.statement,
      rationale: `The team chose this when it set up the project environment (Sprint 0 task ${due.taskId}); the client has not confirmed it.`,
      status: "Inferred",
    };
    return {
      projectId: due.projectId,
      basedOnVersion: due.vision.version,
      inferences: [...parsed.data, assumption],
      changeReason: `stack chosen by Sprint 0 task ${due.taskId}, recorded as Inferred assumption ${assumption.key}`,
      report: stackChoiceReport(due.statement),
    };
  }
}

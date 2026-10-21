import { containEach } from "@ashara/shared";
import type { ProjectId, StepContainment, StepFaulted } from "@ashara/shared";
import { projectBlockCause } from "@ashara/delivery/project-halt";
import type { ProjectBlockCause } from "@ashara/delivery/project-halt";
import { Vision, VisionChangeRefused, VisionUnreadable } from "./vision.js";
import type { RevisionRecord } from "./vision-language/contract-op.js";
import type { StoredVision, VisionAppend } from "./vision.js";

// The stack the team chose in Sprint 0, made visible to the client.
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
  readonly vision: StoredVision | null;
}

interface StackChoiceWrite {
  readonly projectId: ProjectId;
  readonly vision: VisionAppend;
  /** The revision that writes it: Ashara's own, applied unapproved since it promises the client nothing new. */
  readonly revision: RevisionRecord;
  readonly report: string;
}

/** Engagement's persistence port for stack choices. */
export interface StackChoiceStore {
  dueStackChoices(): Promise<readonly DueStackChoice[]>;
  /**
   * Posts the report and appends the vision version after the one it was composed against together,
   * in one transaction; a project already reported on gets nothing new, and one no longer at work
   * under the project row's lock gets nothing ("not-due").
   */
  recordStackChoice(write: StackChoiceWrite): Promise<"recorded" | "already-reported" | "not-due">;
  /** Blocks the project and records why; a project already blocked keeps its first cause. */
  blockProject(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

type StackChoiceOutcome =
  | { readonly kind: "recorded" | "already-reported"; readonly projectId: ProjectId; readonly visionVersion: number }
  /** The project stopped being at work between the listing and the write: nothing is posted, and it is listed again once at work. */
  | { readonly kind: "not-due"; readonly projectId: ProjectId }
  /** The project's record cannot carry the assumption truthfully: nothing is posted and the project is blocked. */
  | { readonly kind: "project-blocked"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause }
  | StepFaulted;

/** What the core loop asks of the Liaison after a Sprint 0 task has merged. */
export interface LiaisonStackChoices {
  runPending(): Promise<readonly StackChoiceOutcome[]>;
}

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

/**
 * Plain words: what the team chose and why, in its own statement; what the environment's test covers,
 * stated here rather than trusted to the statement; and how to say it does not fit.
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
  constructor(
    private readonly store: StackChoiceStore,
    /** Each project's own fault is contained to it (containEach). */
    private readonly containment: StepContainment,
  ) {}

  /**
   * One project's unusable vision blocks that project, and the others are still reported on. Any
   * other failure, a store failure included, is that project's, contained to it (containEach).
   */
  async runPending(): Promise<readonly StackChoiceOutcome[]> {
    const due = await this.store.dueStackChoices();
    return containEach(this.containment, "stack-choice", due, (choice) => ({ id: choice.taskId, projectId: choice.projectId }), async (choice): Promise<StackChoiceOutcome> => {
      let write: StackChoiceWrite;
      try {
        write = this.compose(choice);
      } catch (err) {
        if (!(err instanceof StackChoiceVisionUnusable)) throw err;
        const cause = projectBlockCause(err);
        const result = await this.store.blockProject(choice.projectId, cause);
        console.warn(`[liaison-stack-choice] project ${choice.projectId}: ${cause.errorClass}; project ${result}: ${cause.reason}`);
        return { kind: "project-blocked", projectId: choice.projectId, cause };
      }
      const kind = await this.store.recordStackChoice(write);
      if (kind === "not-due") return { kind, projectId: choice.projectId };
      return { kind, projectId: choice.projectId, visionVersion: write.vision.basedOnVersion + 1 };
    });
  }

  private compose(due: DueStackChoice): StackChoiceWrite {
    if (due.vision === null) throw new StackChoiceVisionUnusable(due.projectId, "the project has no vision");
    try {
      const vision = Vision.read(due.vision).appendInferred({
        statement: due.statement,
        rationale: `The team chose this when it set up the project environment (Sprint 0 task ${due.taskId}); the client has not confirmed it.`,
        // How the product is built, not what it does for the client; this
        // choice's own report tells the client of it.
        kind: "internal-design",
        disclosed: "reported",
        underpins: [],
        changeReason: (key) => `stack chosen by Sprint 0 task ${due.taskId}, recorded as Inferred assumption ${key}`,
      });
      const revision: RevisionRecord = {
        author: "ashara",
        sourceMessageId: null,
        approver: null,
        // An assumption of how the product is built promises the client nothing more or less.
        direction: "neutral",
        cause: "ashara-decision",
        ops: [{ target: "assumption", action: "add", key: vision.key, direction: "neutral", labelled: null, read: null, statement: due.statement }],
        pushback: null,
      };
      return { projectId: due.projectId, vision, revision, report: stackChoiceReport(due.statement) };
    } catch (err) {
      if (!(err instanceof VisionUnreadable || err instanceof VisionChangeRefused)) throw err;
      throw new StackChoiceVisionUnusable(due.projectId, `vision v${due.vision.version}: ${err.message}`);
    }
  }
}

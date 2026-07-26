import { z } from "zod";

/**
 * ProjectFrame — what the agent cannot discover and will otherwise substitute
 * from its training prior (ADR-046). The vision reaches the agent through two
 * LLM-mediated channels that both fail soft; where every link degrades silently,
 * the absence of a fact is indistinguishable from confirmation of the prior, and
 * every prior over "what a software project looks like" has its mode at
 * Node/TypeScript. Runs 36 and 37 built TypeScript projects from a vision that
 * said "a Go CLI tool" — the agent was not uncertain, it was confidently wrong.
 *
 * The frame is the courier channel for OWNER INTENT: a decision the owner has
 * already made, relayed verbatim. That is transmission, not prescription — it
 * does not conflict with ADR-045 ("Ashara provides context, never prescribes"),
 * which governs Ashara's OWN opinions (build commands, check invocations).
 */
export const ProjectFrameSchema = z
  .object({
    /**
     * The project's purpose in the owner's words, VERBATIM from the vision.
     * Verbatim, not paraphrased — the decomposer's paraphrase is the lossy step
     * that dropped "Go" in Run 36.
     */
    intent: z.string().min(1),
    /**
     * Target stack as LABELS ("Go", "SQLite"), never commands. A label states a
     * fact about the project; a command would be Ashara telling the agent how to
     * build it (ADR-045 forbids; ADR-043 assigns that to the agent via verify.toml).
     */
    stack: z.array(z.string().min(1)).nonempty(),
    /**
     * Provenance in descending trust, carried into the prompt so the agent can
     * weigh it and revise from what it observes.
     */
    source: z.enum(["observed-manifest", "contract-knowledge", "vision-derivation"]),
  })
  .strict();

export type ProjectFrame = z.infer<typeof ProjectFrameSchema>;

/** One derivation source that was tried and declined, with why it declined. */
export interface ProjectFrameAttempt {
  readonly source: string;
  readonly reason: string;
}

/**
 * Fail-closed exit of the frame derivation ladder (Discipline A + C): no source
 * could state what this project is, so nothing is dispatched. The message names
 * every rung attempted and why each declined, so reading it alone says which
 * derivation source to fix.
 */
export class ProjectFrameUnresolvable extends Error {
  constructor(
    public readonly context: {
      readonly taskId: string;
      readonly projectId?: string;
      readonly attempted: ReadonlyArray<ProjectFrameAttempt>;
    },
  ) {
    const project = context.projectId ? ` (project ${context.projectId})` : "";
    const declines =
      context.attempted.length > 0
        ? context.attempted.map((a) => `${a.source}: ${a.reason}`).join("; ")
        : "no source was reachable";
    super(
      `Project frame unresolvable for task ${context.taskId}${project} — nothing could state what this project is. ` +
        `Sources attempted, each declined: [${declines}]. ` +
        `Refusing to dispatch is the correct outcome: an agent given no stated target does not notice the gap and ask, ` +
        `it builds the mode of its training prior (Node/TypeScript), so a missing frame yields a confidently wrong ` +
        `project instead of a visible failure. Fix whichever source above is expected to answer for this project.`,
    );
    this.name = "ProjectFrameUnresolvable";
  }
}

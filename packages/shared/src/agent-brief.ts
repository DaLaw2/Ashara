import { z } from "zod";
import { ProjectFrameSchema } from "./project-frame.js";

/**
 * AgentBriefSchema: the validated task instruction the Development BC assembles for one dispatch
 * (ADR-013; ADR-033 §5). It is built in-process, handed to the Workplace attempt loop as its
 * AssignmentBrief, recorded in dev_sessions and written to workdirBase/records/<task>/. Every field
 * is explicit so a producer field outside the schema is a compile error or a parse error
 * (`.strict()`), never an invisible drop (finding-g: `knowledgeContext` and `contextMap` were once
 * assembled at cost and dropped on the way to the prompt).
 *
 * Field tiers:
 *  - FRAME: `projectFrame`, what the project IS (owner intent verbatim, the target stack as labels,
 *    and where that stack was derived from). Required and rendered first: it is the one thing the
 *    agent cannot discover for itself and would otherwise fill in from its training prior (ADR-046).
 *  - BINDING: `taskId`, `goal`, `context`, `deliverables`, `priorAttemptFailure`,
 *    `knowledgeContext`: the instruction, its requirements and prior lessons.
 *  - SUPPLEMENTARY: `contextMap`, reference rendered after the binding sections.
 */
const AgentBriefSchema = z
  .object({
    taskId: z.string().min(1),
    goal: z.string().min(1),
    projectFrame: ProjectFrameSchema,
    context: z.string().min(1),
    deliverables: z.array(z.string()),
    knowledgeContext: z.string().optional(),
    contextMap: z.string().optional(),
    // Non-empty when present: the producer only emits it when it has real content.
    priorAttemptFailure: z.string().min(1).optional(),
  })
  .strict();

export type AgentBrief = z.infer<typeof AgentBriefSchema>;

/**
 * A brief that failed its schema (Discipline A + C): carries the producer site and the per-field
 * Zod issues, so the message alone says which field was malformed.
 * @testseam agent-brief.test.ts asserts the typed rejection
 */
export class InvalidAgentBriefError extends Error {
  constructor(
    public readonly context: {
      readonly source: string;
      readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>;
    },
  ) {
    super(
      `Invalid agent brief from ${context.source}: ` +
        context.issues.map((i) => `${i.path === "" ? "(root)" : i.path}: ${i.message}`).join("; "),
    );
    this.name = "InvalidAgentBriefError";
  }
}

/**
 * Constructs an `AgentBrief` from a typed local value. The compiler checks the shape at the
 * construction site; the Zod parse underneath still runs and throws {@link InvalidAgentBriefError}
 * on a value the type admits but the schema refuses (an empty `taskId`).
 */
export function createAgentBrief(input: AgentBrief, source: string): AgentBrief {
  const result = AgentBriefSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidAgentBriefError({
      source,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

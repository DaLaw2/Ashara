import { z } from "zod";

/**
 * The project environment a task works in, as the brief states it. Ashara never names a stack:
 * a defined environment is passed through as the team's own statement of the stack it chose and
 * why, with the environment version every cell of the task is built from.
 */
const ProjectEnvironmentSchema = z.discriminatedUnion("kind", [
  /** The project has no environment yet: defining it is this task's work (Sprint 0). */
  z.strictObject({ kind: z.literal("to-define") }),
  z.strictObject({
    kind: z.literal("defined"),
    /** sha256 (hex) over the environment's build context (its recipe and the inputs it reads) at the target's main. */
    version: z.string().regex(/^[0-9a-f]{64}$/),
    /** The environment role's statement of the stack it chose and why, verbatim. */
    statement: z.string().min(1),
  }),
]);

/**
 * An assumption of the project's current vision: what work proceeds on until the client says
 * otherwise. `key` is its id within the vision (A1, A2, ...); `note` is what the vision records of
 * it, in words Delivery rendered (O9), so the brief carries no other context's vocabulary.
 */
const VisionAssumptionSchema = z.strictObject({
  key: z.string().min(1),
  statement: z.string().min(1),
  note: z.string().min(1),
});

/**
 * AgentBriefSchema: the validated task instruction Delivery's dispatch assembles for one attempt
 * (ADR-013; ADR-033 §5). It is built in-process, handed to the Workplace attempt loop as its
 * AssignmentBrief, recorded in dev_sessions and written to workdirBase/records/<task>/. Every field
 * is explicit so a producer field outside the schema is a compile error or a parse error
 * (`.strict()`), never an invisible drop: a field assembled at cost and lost on the way to the
 * prompt is caught where it is produced.
 *
 * Field tiers:
 *  - PROJECT: `intent`, the owner's vision verbatim, `assumptions`, the assumptions of that same
 *    vision version (`visionVersion`) work proceeds on, and `projectEnvironment`, the environment
 *    the task works in. Rendered first: what the project is and what it is built with are the things
 *    the agent cannot discover for itself and would otherwise fill in from its training prior.
 *  - BINDING: `taskId`, `goal`, `context`, `deliverables`, `priorAttemptFailure`,
 *    `knowledgeContext`: the instruction, its requirements and prior lessons.
 *  - SUPPLEMENTARY: `contextMap`, reference rendered after the binding sections.
 */
const AgentBriefSchema = z
  .object({
    taskId: z.string().min(1),
    goal: z.string().min(1),
    intent: z.string().min(1),
    visionVersion: z.number().int().min(1),
    assumptions: z.array(VisionAssumptionSchema),
    projectEnvironment: ProjectEnvironmentSchema,
    context: z.string().min(1),
    deliverables: z.array(z.string()),
    knowledgeContext: z.string().optional(),
    contextMap: z.string().optional(),
    // Non-empty when present: the producer only emits it when it has real content.
    priorAttemptFailure: z.string().min(1).optional(),
    // The paths Z0 refuses a task's work for changing, stated before work starts (ADR-074
    // addendum 2 d66 c, d72): `recipe`, the platform role's files, and every stored check file of
    // the project; `inputs` are product files the image build reads, which work may change but
    // which rebuild the environment. Absent only on the BaseCell (Sprint 0), where no environment
    // exists yet.
    protectedPaths: z
      .strictObject({
        recipe: z.array(z.string().min(1)).min(1),
        checkFiles: z.array(z.string().min(1)),
        inputs: z.array(z.string().min(1)),
      })
      .optional(),
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

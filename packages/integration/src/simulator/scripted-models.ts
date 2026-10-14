import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { LanguageModelFactory } from "@ashara/llm-gateway";
import {
  CheckSpecSchema,
  LAYOUT_FILE,
  MANIFEST_FILE,
  RECIPE_DEFECT_SYMPTOM,
  RECIPE_DEFECT_TOKEN,
  TOOLCHAIN_TOKEN,
  behaviourPath,
  taskOfTitle,
  taskTitle,
} from "./product.js";
import type { Database } from "./database.js";
import type { CheckSpec, SimTask, Universe } from "./product.js";
import type { AdversaryRates } from "./profile.js";
import type { Tape } from "./tape.js";

/** A stand-in could not answer: the run's own state contradicts what it was built to model. */
class StandInUnanswerable extends Error {
  constructor(
    readonly site: string,
    readonly detail: string,
  ) {
    super(`scripted model at ${site}: ${detail}`);
    this.name = "StandInUnanswerable";
  }
}

/** What the stand-ins read and decide with. Every project of the run shares one universe. */
export interface StandInContext {
  readonly tape: Tape;
  readonly rates: AdversaryRates;
  readonly universe: Universe;
  readonly observer: Database;
  /** The run's projects (one, or two on one deployment's caps): an agent turn's task is one of theirs. */
  readonly projectIds: readonly string[];
  /** Set by the run once the first merge of an implementation is recorded: a late client change may follow. */
  readonly onModelCall: (call: ModelCallRecord) => void;
  /** The task whose lane makes the call (Interleaver.currentTask), or null outside a batch's tasks. */
  readonly laneTask: () => string | null;
}

/** One model call as the trace records it. */
interface ModelCallRecord {
  readonly site: string;
  readonly action: string;
}

const USAGE = {
  inputTokens: { total: 2000, noCache: 2000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 200, text: 200, reasoning: 0 },
};

function textResult(text: string): LanguageModelV4GenerateResult {
  return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage: USAGE, warnings: [] };
}

let toolCallCounter = 0;

function toolCall(toolName: string, input: unknown): LanguageModelV4GenerateResult {
  toolCallCounter += 1;
  const content: LanguageModelV4Content[] = [
    { type: "tool-call", toolCallId: `sim-call-${toolCallCounter}`, toolName, input: JSON.stringify(input) },
  ];
  return { content, finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE, warnings: [] };
}

const REFUSAL: LanguageModelV4GenerateResult = {
  content: [{ type: "text", text: "I can't help with that." }],
  finishReason: { unified: "content-filter", raw: "content_filter" },
  usage: USAGE,
  warnings: [],
};

const jsonSchemaShape = z.object({
  properties: z.record(z.string(), z.unknown()).optional(),
  anyOf: z.array(z.object({ properties: z.record(z.string(), z.unknown()).optional() })).optional(),
  oneOf: z.array(z.object({ properties: z.record(z.string(), z.unknown()).optional() })).optional(),
});

/** The top-level property names of a structured request's JSON schema: which call site it is. */
function schemaKeys(schema: unknown): string[] {
  const parsed = jsonSchemaShape.safeParse(schema);
  if (!parsed.success) return [];
  const variants = [...(parsed.data.anyOf ?? []), ...(parsed.data.oneOf ?? [])];
  return [...Object.keys(parsed.data.properties ?? {}), ...variants.flatMap((v) => Object.keys(v.properties ?? {}))];
}

const taskRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  taskSpec: z.unknown(),
  workKind: z.string().nullable(),
  dispatchCount: z.number(),
});

const taskSpecShape = z.object({ origin: z.string().optional(), checksFor: z.string().optional() });

const checkRowSchema = z.object({
  checkTaskId: z.string(),
  taskId: z.string(),
  name: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});

type ToolStep = readonly [toolName: string, input: unknown];

/** One attempt's scripted turns, emitted one per model call. */
interface AttemptScript {
  readonly steps: readonly ToolStep[];
  /** Ends the attempt without `finish`: a refusal after the scripted steps. */
  readonly refuses: boolean;
  /** Keeps listing the workspace until the attempt's turn cap ends it. */
  readonly stalls: boolean;
}

/** Every text the call's prompt carries, in order: what a model reads. */
function promptText(options: LanguageModelV4CallOptions): string {
  const parts: string[] = [];
  for (const message of options.prompt) {
    if (message.role === "system") {
      parts.push(message.content);
      continue;
    }
    for (const part of message.content) if (part.type === "text") parts.push(part.text);
  }
  return parts.join("\n");
}

function assistantTurns(options: LanguageModelV4CallOptions): number {
  return options.prompt.filter((message) => message.role === "assistant").length;
}

/**
 * The stand-in for every model call site (design §4.6). A pure function of the tape, the
 * universe, the call and the database: an agent turn reads its task from the lane making the call
 * rather than parsing prompts, since the model port sees no call context (projectId, taskId, callSite).
 */
export class StandIns {
  private readonly attempts = new Map<string, AttemptScript>();

  constructor(private readonly context: StandInContext) {}

  readonly factory: LanguageModelFactory = (provider, model) => this.model(`${provider.name}/${model.id}`);

  private model(modelId: string): LanguageModelV4 {
    return {
      specificationVersion: "v4",
      provider: "ashara-simulator",
      modelId,
      supportedUrls: {},
      doGenerate: (options) => this.respond(options),
      doStream: async () => {
        throw new StandInUnanswerable("stream", "no Ashara call site streams");
      },
    };
  }

  private async respond(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    if (options.tools !== undefined && options.tools.length > 0) return this.agentTurn(options);
    const format = options.responseFormat;
    if (format?.type !== "json") throw new StandInUnanswerable("structured", "a call with no tools asked for no JSON schema");
    const keys = schemaKeys(format.schema);
    if (keys.includes("scopeBoundaries")) return this.structured("liaison-intake", () => this.intake());
    if (keys.includes("roles")) return this.structured("roster", () => this.roster());
    if (keys.includes("nodes")) return this.structured("decomposition.knowledge", () => ({ nodes: [], edges: [] }));
    if (keys.includes("tasks")) return this.structured("decomposition.tasks", () => this.plan());
    if (keys.includes("problems")) return this.structured("suite-review", () => this.review());
    if (keys.includes("verdict")) return this.structured("liaison-answer", () => this.answer());
    if (keys.includes("environmentChange")) {
      // An honest planner reads the evidence it is shown: the recipe defect names itself in the failures.
      const defect = promptText(options).includes(RECIPE_DEFECT_SYMPTOM);      return this.structured("replan.environment", () => ({
        environmentChange: defect,
        reason: defect ? "The build cannot write its cache directory: the environment's recipe must change." : "The change is to product behaviour the environment already builds and tests.",
      }));
    }
    throw new StandInUnanswerable("structured", `no stand-in answers a schema with keys [${keys.join(", ")}]`);
  }

  private async structured(site: string, answer: () => unknown): Promise<LanguageModelV4GenerateResult> {
    if (this.context.tape.chance(`model.${site}.invalid`, this.context.rates.invalidOutput)) {
      this.context.onModelCall({ site, action: "invalid-output" });
      return textResult("{\"not\": \"what was asked\"");
    }
    const value = await answer();
    this.context.onModelCall({ site, action: "answered" });
    return textResult(JSON.stringify(value));
  }

  private intake(): unknown {
    const { universe } = this.context;
    return {
      summary: `A product with ${universe.behaviours.length} behaviours.`,
      scopeBoundaries: universe.behaviours.map((b) => `The product does ${b}.`),
      questions: [
        {
          text: "Which language should messages use?",
          whyItMatters: "It decides what every message shows.",
          assumption: { statement: "Messages are in English.", rationale: "The tender is written in English.", kind: "client-visible" },
        },
      ],
      assumptions: [],
    };
  }

  private roster(): unknown {
    const roles = [
      { name: "Liaison", responsibility: "Talks to the client.", capabilities: ["client-comms"] },
      { name: "Platform", responsibility: "Defines the environment.", capabilities: ["write-environment"] },
      { name: "Developer", responsibility: "Writes the product.", capabilities: ["write-source"] },
      { name: "QA", responsibility: "Writes the checks.", capabilities: ["author-checks"] },
    ];
    if (this.context.tape.chance("model.roster.duplicate-environment", this.context.rates.invalidOutput)) {
      return { roles: [...roles, { name: "Platform 2", responsibility: "Also defines the environment.", capabilities: ["write-environment"] }] };
    }
    return { roles };
  }

  private plan(): unknown {
    const { universe } = this.context;
    return {
      tasks: universe.tasks.map((task, i) => ({
        ref: task.ref,
        title: taskTitle(task),
        description: `Delivers ${task.behaviours.join(", ")}.`,
        dependsOn: i === 0 || universe.independent ? [] : [universe.tasks[i - 1]?.ref ?? task.ref],
        goal: `Deliver ${task.behaviours.join(", ")}`,
        endState: `${task.behaviours.join(", ")} can be used end to end.`,
        scope: `The ${task.behaviours.join(", ")} part of the product.`,
        deliverables: task.behaviours.map((b) => ({ text: `${b} works.`, sources: [`S${universe.behaviours.indexOf(b) + 1}`] })),
        acceptance: task.behaviours.map((b) => ({ text: `A user sees ${b}.`, sources: [`S${universe.behaviours.indexOf(b) + 1}`] })),
        capability: "Medium",
        capabilityReason: "One small behaviour.",
      })),
    };
  }

  /** The suite review finds each wrong, contradictory or out-of-vision check with the profile's probability. */
  private async review(): Promise<unknown> {
    // A review is a task of its own (origin review): the checks it reads are its project's.
    const rows = await this.latestChecks((await this.taskInProgress()).projectId);
    const problems: unknown[] = [];
    for (const row of rows) {
      for (const spec of specsOf(row.files)) {
        if (spec.kind !== "wrong" && spec.kind !== "contradictory" && spec.kind !== "out_of_vision") continue;
        if (!this.context.tape.chance("model.suite-review.catch", this.context.rates.reviewCatch)) continue;
        problems.push({
          checkTasks: [row.checkTaskId],
          kind: spec.kind === "out_of_vision" ? "outside-vision" : "contradiction",
          problem: `Check ${row.name} ${spec.kind === "out_of_vision" ? "asks for behaviour no vision item names" : "cannot pass on correct work"}.`,
          evidence: `It requires [${spec.requires.join(", ")}] and forbids [${spec.forbids.join(", ")}].`,
        });
      }
    }
    return { problems };
  }

  private answer(): unknown {
    return { verdict: "changes", statement: "Messages are in French." };
  }

  private async latestChecks(projectId: string): Promise<Array<z.infer<typeof checkRowSchema>>> {
    const { observer } = this.context;
    const result = await observer.execute(sql`
      SELECT c.check_task_id AS "checkTaskId", c.task_id AS "taskId", c.name, c.files
      FROM task_checks c
      WHERE c.project_id = ${projectId}
        AND c.revision = (SELECT max(revision) FROM task_checks l WHERE l.task_id = c.task_id)
      ORDER BY c.task_id, c.name`);
    return z.array(checkRowSchema).parse(result.rows);
  }

  /** The task of the lane making the call: two of a batch are InProgress at once. */
  private async taskInProgress(): Promise<z.infer<typeof taskRowSchema>> {
    const { observer, projectIds } = this.context;
    const taskId = this.context.laneTask();
    if (taskId === null) throw new StandInUnanswerable("agent-runner", "an agent turn was made outside every task of a batch");
    const result = await observer.execute(sql`
      SELECT id, project_id AS "projectId", title, task_spec AS "taskSpec", work_kind AS "workKind", dispatch_count AS "dispatchCount"
      FROM work_items WHERE id = ${taskId} AND level = 'Task' AND status = 'InProgress'`);
    const [row] = z.array(taskRowSchema).parse(result.rows);
    if (row === undefined || !projectIds.includes(row.projectId)) {
      throw new StandInUnanswerable("agent-runner", `the lane's task ${taskId} is not an InProgress task of the run's projects`);
    }
    return row;
  }

  private async titleOf(id: string): Promise<string> {
    const result = await this.context.observer.execute(sql`SELECT title FROM work_items WHERE id = ${id}`);
    const [row] = z.array(z.object({ title: z.string() })).parse(result.rows);
    if (row === undefined) throw new StandInUnanswerable("agent-runner", `work item ${id} is not on record`);
    return row.title;
  }

  private async agentTurn(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const task = await this.taskInProgress();
    const toolNames = new Set((options.tools ?? []).map((tool) => tool.name));
    const key = `${task.id}#${task.dispatchCount}`;
    let script = this.attempts.get(key);
    if (script === undefined) {
      script = await this.scriptFor(task, toolNames);
      this.attempts.set(key, script);
    }
    const turn = assistantTurns(options);
    const step = script.steps[turn];
    if (step !== undefined) {
      this.context.onModelCall({ site: "agent-runner", action: step[0] });
      return toolCall(step[0], step[1]);
    }
    if (script.stalls) {
      this.context.onModelCall({ site: "agent-runner", action: "stall" });
      return toolCall("list_directory", { path: "." });
    }
    this.context.onModelCall({ site: "agent-runner", action: script.refuses ? "refusal" : "no-more-steps" });
    return REFUSAL;
  }

  private async scriptFor(task: z.infer<typeof taskRowSchema>, tools: ReadonlySet<string>): Promise<AttemptScript> {
    const { tape, rates } = this.context;
    const spec = taskSpecShape.safeParse(task.taskSpec);
    const origin = spec.success ? spec.data.origin : undefined;
    let steps: ToolStep[];
    if (tools.has("build_environment")) steps = this.environmentWork();
    else if (tools.has("define_check")) steps = await this.checkWork(spec.success ? spec.data.checksFor : undefined);
    else if (origin === "product-scaffold") steps = [["write_file", { path: LAYOUT_FILE, content: "behaviours/\n" }], finished("Set up the product layout.")];
    else steps = await this.implementationWork(task, tools);
    if (tape.chance("agent.timeout", rates.timeout)) return { steps: steps.slice(0, -1), refuses: false, stalls: true };
    if (tape.chance("agent.refusal", rates.refusal)) return { steps: steps.slice(0, -1), refuses: true, stalls: false };
    return { steps, refuses: false, stalls: false };
  }

  private environmentWork(): ToolStep[] {
    const defect = this.context.tape.chance("agent.recipe-defect", this.context.rates.recipeDefect);
    const definition = [
      'containerfile = "environment/Containerfile"',
      "recipe = []",
      `inputs = ${JSON.stringify([MANIFEST_FILE])}`,
      'probe = "sim probe"',
      'build = "sim build"',
      'test = "sim test"',
      "",
    ].join("\n");
    const containerfile = ["FROM scratch", `# sim: ${TOOLCHAIN_TOKEN}`, ...(defect ? [`# sim: ${RECIPE_DEFECT_TOKEN}`] : []), ""].join("\n");
    return [
      ["write_file", { path: "environment/environment.toml", content: definition }],
      ["write_file", { path: "environment/Containerfile", content: containerfile }],
      ["build_environment", {}],
      [
        "finish",
        {
          status: "done",
          summary: "Defined the environment.",
          statement: "The simulated toolchain; the product is built with `sim build` and tested with `sim test`.",
        },
      ],
    ];
  }

  private async checkWork(checksFor: string | undefined): Promise<ToolStep[]> {
    const { tape, rates, universe } = this.context;
    if (checksFor === undefined) throw new StandInUnanswerable("agent-runner", "a check task names no task it checks");
    const checked = taskOfTitle(universe, await this.titleOf(checksFor));
    if (checked === null) throw new StandInUnanswerable("agent-runner", `check task for ${checksFor}: its title carries no simulator marker`);
    const checks: Array<{ readonly name: string; readonly spec: CheckSpec }> = checked.behaviours.map((b) => ({
      name: `has-${b}`,
      spec: { kind: "correct", requires: [b], forbids: [], harness: [] },
    }));
    const other = universe.tasks.find((t) => t.ref !== checked.ref);
    const extra = (name: string, spec: CheckSpec): void => void checks.push({ name, spec });
    if (tape.chance("agent.check.wrong", rates.wrongCheck)) extra("wrong", { kind: "wrong", requires: ["b-never"], forbids: [], harness: [] });
    if (other !== undefined && tape.chance("agent.check.contradictory", rates.contradictoryCheck)) {
      extra("contradicts", { kind: "contradictory", requires: [], forbids: [...other.behaviours], harness: [] });
    }
    if (tape.chance("agent.check.vacuous", rates.vacuousCheck)) extra("vacuous", { kind: "vacuous", requires: [], forbids: [], harness: [] });
    if (tape.chance("agent.check.out-of-vision", rates.outOfVisionCheck)) {
      extra("extra", { kind: "out_of_vision", requires: [universe.outOfVision], forbids: [], harness: [] });
    }
    if (tape.chance("agent.check.flaky", rates.flakyCheck)) extra("flaky", { kind: "flaky", requires: [...checked.behaviours], forbids: [], harness: [] });
    if (tape.chance("agent.check.unrunnable", rates.unrunnableCheck)) {
      extra("unrunnable", { kind: tape.pick("agent.check.unrunnable-kind", 2) === 0 ? "unrunnable" : "slow", requires: [], forbids: [], harness: [] });
    }
    if (tape.chance("agent.check.harness", rates.flakyCheck)) {
      extra("harness", { kind: "correct", requires: [...checked.behaviours], forbids: [], harness: [{ path: `product/harness/${checked.ref}`, content: "harness\n" }] });
    }
    const allGuard = tape.chance("agent.check.all-guard", rates.allGuardSet);
    const kept = allGuard ? checks.map((check) => ({ name: check.name, spec: { ...check.spec, kind: "vacuous" as const } })) : checks;
    const steps: ToolStep[] = [];
    for (const check of kept) {
      // The checks directory the brief names (checkAreaOf): the checked task's id, not the simulator's ref.
      const path = `checks/${checksFor}/${check.name}.json`;
      steps.push(["write_file", { path, content: `${JSON.stringify(check.spec)}\n` }]);
      steps.push(["define_check", { name: check.name, command: `sim check ${path}` }]);
    }
    // Run 8 E1, E2: the author also writes the product it checks, in its own workspace.
    if (tape.chance("agent.check.writes-product", rates.authorWritesProduct)) {
      for (const b of checked.behaviours) steps.push(["write_file", { path: behaviourPath(b), content: `${b} by the check author\n` }]);
    }
    steps.push(finished(`Defined ${kept.length} check(s).`));
    return steps;
  }

  private async implementationWork(task: z.infer<typeof taskRowSchema>, tools: ReadonlySet<string>): Promise<ToolStep[]> {
    const { tape, rates, universe } = this.context;
    const mine = taskOfTitle(universe, task.title);
    if (mine === null) throw new StandInUnanswerable("agent-runner", `implementation ${task.id} "${task.title}" carries no simulator marker`);
    const index = universe.tasks.indexOf(mine);
    let behaviours = [...mine.behaviours];
    const underDelivers = behaviours.length > 0 && tape.chance("agent.under-delivery", rates.underDelivery);
    if (underDelivers) behaviours = behaviours.slice(0, -1);
    const later: SimTask[] = universe.tasks.slice(index + 1);
    if (later.length > 0 && tape.chance("agent.over-delivery", rates.overDelivery)) behaviours.push(...(later[0]?.behaviours ?? []));
    const steps: ToolStep[] = behaviours.map((b) => ["write_file", { path: behaviourPath(b), content: `${b}\n` }]);
    const earlier = universe.tasks.slice(0, index).flatMap((t) => t.behaviours);
    const victim = earlier[0];
    if (victim !== undefined && tape.chance("agent.regression", rates.regression)) {
      steps.push(["run_command", { command: `sim rm ${behaviourPath(victim)}` }]);
    }
    if (tape.chance("agent.manifest", rates.overDelivery / 3)) steps.push(["write_file", { path: MANIFEST_FILE, content: `${mine.ref}\n` }]);
    if (tools.has("dispute_check")) {
      const dispute = await this.disputeOf(task, underDelivers);
      if (dispute !== null) {
        steps.push(["run_checks", {}]);
        steps.push(["dispute_check", dispute]);
        return steps;
      }
    }
    steps.push(finished(`Delivered ${behaviours.join(", ")}.`));
    return steps;
  }

  /** A dispute of one of the task's own stored checks: right when the check is bad, wrong otherwise. */
  private async disputeOf(task: z.infer<typeof taskRowSchema>, underDelivered: boolean): Promise<{ name: string; reason: string } | null> {
    const { tape, rates } = this.context;
    const own = (await this.latestChecks(task.projectId)).filter((row) => row.taskId === task.id);
    for (const row of own) {
      for (const spec of specsOf(row.files)) {
        const bad = spec.kind === "wrong" || spec.kind === "contradictory" || spec.kind === "out_of_vision" || spec.kind === "unrunnable" || spec.kind === "slow";
        if (bad && tape.chance("agent.dispute.right", rates.disputeRight)) {
          return { name: row.name, reason: `The check ${spec.kind === "out_of_vision" ? "asks for behaviour the vision does not name" : "cannot pass on correct work"}.` };
        }
        if (!bad && underDelivered && tape.chance("agent.dispute.wrong", rates.disputeWrong)) {
          return { name: row.name, reason: "The check is too strict." };
        }
      }
    }
    return null;
  }
}

function finished(summary: string): ToolStep {
  return ["finish", { status: "done", summary }];
}

/** The check specs a stored check's files hold; a file that is not one is skipped. */
function specsOf(files: ReadonlyArray<{ readonly path: string; readonly content: string }>): CheckSpec[] {
  const specs: CheckSpec[] = [];
  for (const file of files) {
    if (!file.path.endsWith(".json")) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(file.content);
    } catch (err) {
      console.warn(`[simulator] check file ${file.path} is not JSON, skipped: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const spec = CheckSpecSchema.safeParse(raw);
    if (spec.success) specs.push(spec.data);
  }
  return specs;
}

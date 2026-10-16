import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { LanguageModelFactory } from "@ashara/model-access";
import {
  CheckSpecSchema,
  INTERFACE_TASK_REF,
  INTERFACE_TASK_TITLE,
  LAYOUT_FILE,
  MANIFEST_FILE,
  MISREAD_REJECTION_MARKER,
  MISSING_INTERFACE_EVIDENCE,
  PLACEHOLDER_INTERFACE_EVIDENCE,
  PUBLIC_INTERFACE_PATH,
  RECIPE_DEFECT_SYMPTOM,
  RECIPE_DEFECT_TOKEN,
  SHARED_INDEX_FILE,
  TOOLCHAIN_TOKEN,
  behaviourPath,
  deliveredInterfaceText,
  isInterfaceTaskTitle,
  publicInterfaceText,
  taskOfTitle,
  taskTitle,
} from "./product.js";
import type { Database } from "./database.js";
import type { CheckSpec, InterfaceForm, SimTask, Universe } from "./product.js";
import type { Personas } from "./personas.js";
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
interface StandInContext {
  readonly tape: Tape;
  readonly rates: AdversaryRates;
  readonly universe: Universe;
  /** The seed's sticky personas (personas.ts): who misbehaves, and when. */
  readonly personas: Personas;
  readonly observer: Database;
  /** The run's projects (one, or two on one deployment's caps): an agent turn's task is one of theirs. */
  readonly projectIds: readonly string[];
  /** Set by the run once the first merge of an implementation is recorded: a late client change may follow. */
  readonly onModelCall: (call: ModelCallRecord) => void;
  /** Once per request the model port receives, before it is answered: W1 counts work here, outside production (termination.ts). */
  readonly onRequest: () => void;
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

/** `callNumber` counts within one run's stand-ins: a count kept across runs made a seed's prompts depend on the seeds before it. */
function toolCall(callNumber: number, toolName: string, input: unknown): LanguageModelV4GenerateResult {
  const content: LanguageModelV4Content[] = [
    { type: "tool-call", toolCallId: `sim-call-${callNumber}`, toolName, input: JSON.stringify(input) },
  ];
  return { content, finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE, warnings: [] };
}

const REFUSAL: LanguageModelV4GenerateResult = {
  content: [{ type: "text", text: "I can't help with that." }],
  finishReason: { unified: "content-filter", raw: "content_filter" },
  usage: USAGE,
  warnings: [],
};

/** The output bound a request names, or the gateway's turn bound when it names none. */
const DEFAULT_OUTPUT_BOUND = 16_384;

function outputBoundOf(options: LanguageModelV4CallOptions): number {
  return options.maxOutputTokens ?? DEFAULT_OUTPUT_BOUND;
}

/** A response with no content at all: no text, no tool call, nothing billed for output. */
const EMPTY: LanguageModelV4GenerateResult = {
  content: [],
  finishReason: { unified: "stop", raw: "stop" },
  usage: { inputTokens: USAGE.inputTokens, outputTokens: { total: 0, text: 0, reasoning: 0 } },
  warnings: [],
};

/** Output cut at the bound: `content` is what arrived before the cut, every token of the bound billed as text. */
function cutAtBound(content: LanguageModelV4Content[], bound: number): LanguageModelV4GenerateResult {
  return {
    content,
    finishReason: { unified: "length", raw: "length" },
    usage: { inputTokens: USAGE.inputTokens, outputTokens: { total: bound, text: bound, reasoning: 0 } },
    warnings: [],
  };
}

/**
 * The whole output bound spent on reasoning, no answer: the reasoning count
 * in the wire format a Chat Completions provider reports it in, where the gateway reads it.
 */
function reasoningOnly(bound: number): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "reasoning", text: "Let me think about every part of this carefully before answering." }],
    finishReason: { unified: "length", raw: "length" },
    usage: {
      inputTokens: USAGE.inputTokens,
      outputTokens: { total: bound, text: 0, reasoning: bound },
      raw: { completion_tokens: bound, completion_tokens_details: { reasoning_tokens: bound } },
    },
    warnings: [],
  };
}

/** The first half of a JSON text: never valid JSON itself, as an answer cut mid-object is not. */
function firstHalf(json: string): string {
  return json.slice(0, Math.max(1, Math.floor(json.length / 2)));
}

/** The brief section of an attempt handed its conflict with main (Quality merge.ts formatConflictForBrief). */
const CONFLICT_HEADING = "## Merge with main in progress";

/** The files a conflict section lists, `- <path>` one per line; none when the prompt has no such section. */
function conflictFilesOf(prompt: string): string[] {
  const at = prompt.indexOf(CONFLICT_HEADING);
  if (at < 0) return [];
  const files: string[] = [];
  for (const line of prompt.slice(at + CONFLICT_HEADING.length).split("\n")) {
    if (line.startsWith("- ")) files.push(line.slice(2).trim());
    else if (files.length > 0) break;
  }
  return files;
}

const jsonSchemaShape = z.object({
  properties: z.record(z.string(), z.unknown()).optional(),
  anyOf: z.array(z.object({ properties: z.record(z.string(), z.unknown()).optional() })).optional(),
  oneOf: z.array(z.object({ properties: z.record(z.string(), z.unknown()).optional() })).optional(),
});

/** The top-level property names of a structured request's JSON schema: which call site it is. */
function schemaKeys(schema: unknown): string[] {
  const parsed = jsonSchemaShape.safeParse(schema);
  if (!parsed.success) return [];
  // eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a JSON schema without variants has none; no oracle reads it
  const variants = [...(parsed.data.anyOf ?? []), ...(parsed.data.oneOf ?? [])];
  // eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a JSON schema without properties has none; no oracle reads it
  return [...Object.keys(parsed.data.properties ?? {}), ...variants.flatMap((v) => Object.keys(v.properties ?? {}))];
}

const taskRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  taskSpec: z.unknown(),
  workKind: z.string().nullable(),
  dispatchCount: z.number(),
  infrastructureFaults: z.number(),
});

const taskSpecShape = z.object({
  origin: z.string().optional(),
  checksFor: z.string().optional(),
  sources: z.array(z.object({ id: z.string() })).optional(),
});

const checkRowSchema = z.object({
  checkTaskId: z.string(),
  taskId: z.string(),
  revision: z.number().int(),
  name: z.string(),
  command: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});

const citedItemSchema = z.object({ id: z.string(), text: z.string() });

type ToolStep = readonly [toolName: string, input: unknown];

/** One review task's round as its persona reads it: a round is the check revisions read; each call of it counts. */
interface ReviewRound {
  readonly checks: string;
  readonly round: number;
  calls: number;
  first: unknown[] | null;
}

/** The bad checks a sticky-bad check author writes again on every rewrite. */
const STICKY_KINDS = ["contradictory", "wrong", "out_of_vision"] as const;
type StickyKind = (typeof STICKY_KINDS)[number];

/**
 * What the first turn past an attempt's scripted steps answers:
 * - complete: its steps end the attempt (finish, dispute); a turn past them is refused;
 * - refusal: a refusal (content filter), no tool call;
 * - stall: lists the workspace every turn until the attempt's turn cap ends it;
 * - stall-mid-edit: the same, after only some of its edits (the trace tells the two apart);
 * - truncated: the turn is cut at the output limit while writing its next tool call;
 * - empty: the turn has no content at all;
 * - reasoning-exhausted: the turn's whole output bound goes to reasoning, no content.
 */
type AttemptEnd = "complete" | "refusal" | "stall" | "stall-mid-edit" | "truncated" | "empty" | "reasoning-exhausted";

/** What an attempt is for, as its tools and its task's origin show: the scope of its draws (Tape Direction). */
type WorkKind = "environment" | "checks" | "scaffold" | "implementation";

/** One attempt's scripted turns, emitted one per model call. */
interface AttemptScript {
  readonly steps: readonly ToolStep[];
  readonly end: AttemptEnd;
  /** The tool call a truncated turn was writing when it was cut; null for every other end. */
  readonly cut: ToolStep | null;
}

/**
 * The vision items the planner's prompt says a task must cite (d89 E, ADR-083), as an honest planner
 * reads them; none when the prompt asks for none. Reads the prompt as text or as its JSON.
 */
function itemsToCheck(prompt: string): string[] {
  const listed = /a plan that leaves one uncited is rejected: ([A-Za-z0-9_-]+(?:, [A-Za-z0-9_-]+)*)\./.exec(prompt)?.[1];
  return listed === undefined ? [] : listed.split(", ");
}

type ScriptedLine = { readonly text: string; readonly sources: readonly string[] };

interface ScriptedPlan {
  readonly tasks: ReadonlyArray<Record<string, unknown> & { readonly acceptance: readonly ScriptedLine[] }>;
}

/**
 * `tasks` as an honest planner cites what `toCheck` lists: each line cites only the items its own text
 * tests, so an item no line cites yet gets a line of its own on the first task, stating it.
 */
function citingPerLine<T extends { readonly acceptance: readonly ScriptedLine[] }>(tasks: readonly T[], toCheck: readonly string[]): T[] {
  const cited = new Set(tasks.flatMap((task) => task.acceptance.flatMap((line) => line.sources)));
  const lines = toCheck.filter((id) => !cited.has(id)).map((id) => ({ text: `A user sees what ${id} states hold.`, sources: [id] }));
  return tasks.map((task, i) => (i > 0 || lines.length === 0 ? task : { ...task, acceptance: [...task.acceptance, ...lines] }));
}

/**
 * `plan` as an honest planner answers `prompt`: every item the prompt says a task must cite (d89 E,
 * ADR-083) that no line cites yet gets an acceptance line of its own that cites it alone.
 *
 * @testseam the integration planning tests' scripted planners answer through it, reading the prompt as the simulator's planner does
 */
export function citingItemsToCheck(plan: ScriptedPlan, prompt: string): ScriptedPlan {
  return { tasks: citingPerLine(plan.tasks, itemsToCheck(prompt)) };
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
  /**
   * The form of public interface file each project's latest scripted scaffold wrote (null: none),
   * so an implementer updating it keeps its form. The latest is the one merged: a scaffold attempt
   * that merged is followed by no other.
   */
  private readonly interfaceForms = new Map<string, InterfaceForm | null>();
  private toolCalls = 0;
  /** Plans answered so far: the oscillating planner reverses every other one. */
  private plans = 0;
  /** Classifications the flipping classifier has acted on: every other one is flipped. */
  private classifications = 0;
  /** Persona findings worded so far: each new one is worded anew. */
  private personaWords = 0;
  /** Each review task's current round: the check revisions it reads, how many calls read them, the first call's answer. */
  private readonly reviewRounds = new Map<string, ReviewRound>();
  /** The first rejection a resurrecting reviewer made in each project, raised again word for word ever after. */
  private readonly resurrected = new Map<string, unknown>();
  /** The checked tasks a sticky-bad check author has written a bad check for: every rewrite writes it again. */
  private readonly stickyBad = new Set<string>();
  /** The bad check a sticky-bad check author writes, drawn once per run. */
  private stickyKind: StickyKind | null = null;

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
    this.context.onRequest();
    if (options.tools !== undefined && options.tools.length > 0) return this.agentTurn(options);
    const format = options.responseFormat;
    if (format?.type !== "json") throw new StandInUnanswerable("structured", "a call with no tools asked for no JSON schema");
    const keys = schemaKeys(format.schema);
    if (keys.includes("inScope")) return this.structured(options, "liaison-intake", () => this.intake());
    if (keys.includes("roles")) return this.structured(options, "roster", () => this.roster());
    if (keys.includes("tasks")) return this.structured(options, "decomposition.tasks", () => this.plan(promptText(options)));
    if (keys.includes("problems")) return this.structured(options, "suite-review", () => this.review());
    if (keys.includes("verdict")) return this.structured(options, "liaison-answer", () => this.answer());
    if (keys.includes("environmentChange")) {
      // An honest planner reads the evidence it is shown: the recipe defect names itself in the failures.
      const defect = promptText(options).includes(RECIPE_DEFECT_SYMPTOM);
      return this.structured(options, "replan.environment", () => {
        const environmentChange = this.classifierFlips() ? !defect : defect;
        return {
          environmentChange,
          reason: environmentChange ? "The build cannot write its cache directory: the environment's recipe must change." : "The change is to product behaviour the environment already builds and tests.",
        };
      });
    }
    throw new StandInUnanswerable("structured", `no stand-in answers a schema with keys [${keys.join(", ")}]`);
  }

  /**
   * One structured answer, or one of the response-level misbehaviours a provider shows: output
   * that does not parse, no content, the whole bound spent on reasoning, or the answer cut at the
   * bound mid-object.
   */
  private async structured(options: LanguageModelV4CallOptions, site: string, answer: () => unknown): Promise<LanguageModelV4GenerateResult> {
    const { tape, rates, onModelCall } = this.context;
    if (tape.chance(`model.${site}.invalid`, rates.invalidOutput)) {
      onModelCall({ site, action: "invalid-output" });
      return textResult("{\"not\": \"what was asked\"");
    }
    if (tape.chance(`model.${site}.empty`, rates.emptyStructured)) {
      onModelCall({ site, action: "empty" });
      return EMPTY;
    }
    if (tape.chance(`model.${site}.reasoning-exhausted`, rates.reasoningExhausted)) {
      onModelCall({ site, action: "reasoning-exhausted" });
      return reasoningOnly(outputBoundOf(options));
    }
    const value = await answer();
    if (tape.chance(`model.${site}.truncated`, rates.truncatedStructured)) {
      onModelCall({ site, action: "truncated" });
      return cutAtBound([{ type: "text", text: firstHalf(JSON.stringify(value)) }], outputBoundOf(options));
    }
    onModelCall({ site, action: "answered" });
    return textResult(JSON.stringify(value));
  }

  private intake(): unknown {
    const { universe } = this.context;
    return {
      summary: `A product with ${universe.behaviours.length} behaviours.`,
      // The last line names no behaviour, so only the honest planner's line of its own (citingPerLine) cites it and only that line's check decides it.
      inScope: [...universe.behaviours.map((b) => `The product does ${b}.`), "Every message reads the same on every run."],
      outOfScope: ["Any network service."],
      questions: [
        {
          text: "Which language should messages use?",
          whyItMatters: "It decides what every message shows.",
          // A model that cannot tell answers "undecided" (ADR-083): the vision records it client-visible, so it is checked.
          assumption: { statement: "Messages are in English.", rationale: "The tender is written in English.", kind: "undecided" },
        },
      ],
      assumptions: [{ statement: "The product keeps no state between runs.", rationale: "The tender names no stored data.", kind: "internal-design" }],
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

  /**
   * The universe's tasks; a repair whose evidence says acceptance refused main's public interface
   * file as the scaffold's, or as missing, also plans a task to write it, which no universe task's
   * checks ask for.
   */
  private plan(prompt: string): unknown {
    const { universe } = this.context;
    const toCheck = itemsToCheck(prompt);
    const interfaceTask = prompt.includes(PLACEHOLDER_INTERFACE_EVIDENCE) || prompt.includes(MISSING_INTERFACE_EVIDENCE)
      ? [
          {
            ref: INTERFACE_TASK_REF,
            title: INTERFACE_TASK_TITLE,
            description: `Updates ${PUBLIC_INTERFACE_PATH} to describe the delivered product.`,
            dependsOn: [],
            goal: `${PUBLIC_INTERFACE_PATH} describes the delivered product`,
            endState: `${PUBLIC_INTERFACE_PATH} is no longer the scaffold's.`,
            scope: `${PUBLIC_INTERFACE_PATH} only.`,
            deliverables: [{ text: `${PUBLIC_INTERFACE_PATH} describes the product.`, sources: ["S1"] }],
            acceptance: [{ text: `A user reads how to run the product in ${PUBLIC_INTERFACE_PATH}.`, sources: ["S1"] }],
            capability: "Medium",
            capabilityReason: "One file.",
          },
        ]
      : [];
    // Answering that evidence, it plans only what is still to do: a done task planned again could
    // never have a check fail on its foundation.
    const todo = interfaceTask.length === 0 ? universe.tasks : universe.tasks.filter((task) => !prompt.includes(`\n- ${taskTitle(task)}`));
    const planned = this.plannerReverses() ? [...todo].reverse() : todo;
    return {
      tasks: citingPerLine([...planned.map((task, i) => ({
        ref: task.ref,
        title: taskTitle(task),
        description: `Delivers ${task.behaviours.join(", ")}.`,
        dependsOn: i === 0 || universe.independent ? [] : [planned[i - 1]?.ref ?? task.ref],
        goal: `Deliver ${task.behaviours.join(", ")}`,
        endState: `${task.behaviours.join(", ")} can be used end to end.`,
        scope: `The ${task.behaviours.join(", ")} part of the product.`,
        deliverables: task.behaviours.map((b) => ({ text: `${b} works.`, sources: [`S${universe.behaviours.indexOf(b) + 1}`] })),
        acceptance: task.behaviours.map((b) => ({ text: `A user sees ${b}.`, sources: [`S${universe.behaviours.indexOf(b) + 1}`] })),
        capability: "Medium",
        capabilityReason: "One small behaviour.",
      })), ...interfaceTask], toCheck),
    };
  }

  /** Whether the oscillating planner reverses this plan: every other plan it answers, when its persona fires. */
  private plannerReverses(): boolean {
    const { personas, onModelCall } = this.context;
    if (personas.of("planner") !== "oscillating") return false;
    this.plans += 1;
    if (this.plans % 2 === 1 || !personas.fires("planner")) return false;
    onModelCall({ site: "decomposition.tasks", action: "persona oscillating: the plan reversed" });
    return true;
  }

  /** Whether the flipping classifier answers against its evidence: every other time its persona fires. */
  private classifierFlips(): boolean {
    const { personas, onModelCall } = this.context;
    if (personas.of("classifier") !== "flipping" || !personas.fires("classifier")) return false;
    this.classifications += 1;
    if (this.classifications % 2 === 0) return false;
    onModelCall({ site: "replan.environment", action: "persona flipping: answers against its evidence" });
    return true;
  }

  /**
   * The suite review finds each contradictory or out-of-vision check with the profile's probability.
   * A contradiction names the two checks, each with its command quoted as what it requires: the
   * contradictory check and a check of another check task that requires what it forbids. A wrong
   * check contradicts no other check: only a run of it on correct work witnesses it (a dispute).
   * A doubting review names a cited item of a sound suite as undecided, which only another model
   * family's agreement could act on.
   */
  private async review(): Promise<unknown> {
    // A review is a task of its own (origin review): the checks it reads are its project's.
    const task = await this.taskInProgress();
    const rows = await this.latestChecks(task.projectId);
    const honest = await this.honestReview(rows);
    if (this.context.personas.of("suite-review") === "honest") return { problems: honest };
    return { problems: await this.reviewAsPersona(task, rows, honest) };
  }

  private async honestReview(rows: ReadonlyArray<z.infer<typeof checkRowSchema>>): Promise<unknown[]> {
    const problems: unknown[] = [];
    for (const row of rows) {
      const own = ownSpecOf(row);
      if (own?.kind !== "contradictory" || !this.context.tape.chance("model.suite-review.catch", this.context.rates.reviewCatch)) continue;
      const partner = rows.find((other) => other.checkTaskId !== row.checkTaskId && requiresAny(ownSpecOf(other), own.forbids));
      if (partner === undefined) continue;
      problems.push({
        checkTasks: [row.checkTaskId, partner.checkTaskId],
        kind: "contradiction",
        conflict: [
          { checkTask: row.checkTaskId, check: row.name, requires: row.command },
          { checkTask: partner.checkTaskId, check: partner.name, requires: partner.command },
        ],
        problem: `Check ${row.name} forbids [${own.forbids.join(", ")}], which check ${partner.name} requires.`,
        evidence: `${row.command}; ${partner.command}`,
      });
    }
    for (const row of rows) {
      for (const spec of specsOf(row.files)) {
        if (spec.kind !== "out_of_vision") continue;
        if (!this.context.tape.chance("model.suite-review.catch", this.context.rates.reviewCatch)) continue;
        const evidence = `It requires [${spec.requires.join(", ")}] and forbids [${spec.forbids.join(", ")}].`;
        const cited = await this.citedBy(row.checkTaskId);
        problems.push({
          checkTasks: [row.checkTaskId],
          kind: "outside-vision",
          check: row.name,
          judgedItems: cited.map((item) => item.id),
          missingClause: `does ${spec.requires.join(" and ")}`,
          problem: `Check ${row.name} asks for behaviour no vision item names.`,
          evidence,
        });
      }
    }
    // A misread: a correct check rejected as outside the vision, quoting as missing the very text its cited item
    // states. Z0 must find that text in the cited item and discard the rejection, so a correct check is never reopened on it.
    const correct = rows.find((row) => specsOf(row.files).some((spec) => spec.kind === "correct"));
    if (correct !== undefined && this.context.tape.chance("model.suite-review.misread", this.context.rates.reviewMisread)) {
      const [item] = await this.citedBy(correct.checkTaskId);
      if (item !== undefined) {
        this.context.onModelCall({ site: "suite-review", action: "misread" });
        problems.push({
          checkTasks: [correct.checkTaskId],
          kind: "outside-vision",
          check: correct.name,
          judgedItems: [item.id],
          missingClause: item.text,
          problem: `Check ${correct.name} asks for behaviour no cited item names (${MISREAD_REJECTION_MARKER}).`,
          evidence: `${item.id} is read as not asking for it.`,
        });
      }
    }
    const sound = rows.find((row) => ownSpecOf(row)?.kind === "correct");
    if (sound !== undefined && this.context.tape.chance("model.suite-review.undecided", this.context.rates.reviewMisread)) {
      const [item] = await this.citedBy(sound.checkTaskId);
      if (item !== undefined) {
        this.context.onModelCall({ site: "suite-review", action: "undecided" });
        problems.push({ checkTasks: [sound.checkTaskId], kind: "undecided-item", item: item.id, problem: `No check of the suite is read as deciding ${item.id}.`, evidence: sound.command });
      }
    }
    return problems;
  }

  /**
   * The review as the seed's reviewer persona answers it (personas.ts). Its findings name only the
   * correct checks of the check tasks under review, read from the universe's own check kinds, so
   * what it raises is plausible and wrong; how production weighs it is production's.
   */
  private async reviewAsPersona(task: z.infer<typeof taskRowSchema>, rows: ReadonlyArray<z.infer<typeof checkRowSchema>>, honest: readonly unknown[]): Promise<unknown[]> {
    const { personas, onModelCall } = this.context;
    const persona = personas.of("suite-review");
    const underReview = await this.checkTasksUnderReview(task.id);
    const read = rows.filter((row) => underReview.includes(row.checkTaskId));
    const round = this.reviewRound(task.id, read);
    // The same model asked again with the same prompt answers as it did: the copy is the persona, whatever fired.
    if (persona === "correlated-second" && round.calls > 1 && round.first !== null) {
      onModelCall({ site: "suite-review", action: "persona correlated-second: the first review's answer again" });
      return round.first;
    }
    if (!personas.fires("suite-review")) return this.answered(round, [...honest]);
    onModelCall({ site: "suite-review", action: `persona ${persona} (round ${round.round}, review ${round.calls})` });
    const targets = [...new Set(read.filter((row) => ownSpecOf(row)?.kind === "correct").map((row) => row.checkTaskId))];
    const target = (n: number): z.infer<typeof checkRowSchema> | undefined => {
      const id = targets[n % Math.max(1, targets.length)];
      return read.find((row) => row.checkTaskId === id && ownSpecOf(row)?.kind === "correct");
    };
    switch (persona) {
      case "never-satisfied": {
        const row = target(0);
        if (row === undefined) return this.answered(round, [...honest]);
        const cited = await this.citedBy(row.checkTaskId);
        const item = cited[(round.round + round.calls) % Math.max(1, cited.length)];
        const undecided = item === undefined ? [] : [{ checkTasks: [row.checkTaskId], kind: "undecided-item", item: item.id, problem: `No check is read as deciding ${item.id} (reading ${this.nextWording()}).`, evidence: row.command }];
        return this.answered(round, [...honest, await this.rejection(row), ...undecided]);
      }
      case "rotating": {
        const row = target(round.round - 1);
        return this.answered(round, row === undefined ? [...honest] : [...honest, await this.rejection(row)]);
      }
      case "resurrecting": {
        const earlier = this.resurrected.get(task.projectId);
        if (earlier !== undefined) return this.answered(round, [...honest, earlier]);
        const row = target(0);
        if (row === undefined) return this.answered(round, [...honest]);
        const first = await this.rejection(row);
        this.resurrected.set(task.projectId, first);
        return this.answered(round, [...honest, first]);
      }
      case "flip-flop": {
        if (round.round % 2 === 0) return this.answered(round, []);
        const row = target(0);
        return this.answered(round, row === undefined ? [...honest] : [...honest, await this.rejection(row, `its round ${round.round}`)]);
      }
      case "self-refuting": {
        const row = target(0);
        if (row === undefined) return this.answered(round, [...honest]);
        const side = { checkTask: row.checkTaskId, check: row.name, requires: row.command };
        return this.answered(round, [
          ...honest,
          { checkTasks: [row.checkTaskId], kind: "contradiction", conflict: [side, side], problem: `Check ${row.name} both requires and forbids what it runs.`, evidence: row.command },
        ]);
      }
      case "correlated-second": {
        const row = target(0);
        return this.answered(round, row === undefined ? [...honest] : [...honest, await this.rejection(row)]);
      }
      case "lazy-pass":
        return this.answered(round, []);
      case "honest":
        return this.answered(round, [...honest]);
    }
  }

  /** `problems` as this call's answer, kept as its round's first when it is the first call of the round. */
  private answered(round: ReviewRound, problems: unknown[]): unknown[] {
    if (round.calls === 1) round.first = problems;
    return problems;
  }

  /** A fresh wording, never used before in the run. */
  private nextWording(): string {
    this.personaWords += 1;
    return `variant ${this.personaWords}`;
  }

  /**
   * A rejection of a correct check as outside the vision, its missing clause a paraphrase no cited
   * item states word for word (the blind spot Z0 names), worded anew unless `wording` fixes it.
   */
  private async rejection(row: z.infer<typeof checkRowSchema>, wording?: string): Promise<unknown> {
    const spec = ownSpecOf(row);
    // eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a check whose spec is unreadable requires nothing the clause can name; no oracle reads it
    const requires = spec?.requires ?? [];
    const cited = await this.citedBy(row.checkTaskId);
    return {
      checkTasks: [row.checkTaskId],
      kind: "outside-vision",
      check: row.name,
      judgedItems: cited.map((item) => item.id),
      missingClause: `performs ${requires.join(" and ")} in ${wording ?? `its ${this.nextWording()}`}`,
      problem: `Check ${row.name} asks for a form of behaviour none of its cited items names.`,
      evidence: row.command,
    };
  }

  /** The review's round: a new one whenever the check revisions it reads change; this call counted in it. */
  private reviewRound(reviewTaskId: string, read: ReadonlyArray<z.infer<typeof checkRowSchema>>): ReviewRound {
    const checks = [...new Set(read.map((row) => `${row.taskId}@${row.revision}`))].sort().join(" ");
    const known = this.reviewRounds.get(reviewTaskId);
    if (known !== undefined && known.checks === checks) {
      known.calls += 1;
      return known;
    }
    const round: ReviewRound = { checks, round: known === undefined ? 1 : known.round + 1, calls: 1, first: null };
    this.reviewRounds.set(reviewTaskId, round);
    return round;
  }

  /** The finished check tasks a review task depends on: the suites it reads. */
  private async checkTasksUnderReview(reviewTaskId: string): Promise<string[]> {
    const result = await this.context.observer.execute(sql`
      SELECT w.id FROM dependencies d JOIN work_items w ON w.id = d.to_id
      WHERE d.from_id = ${reviewTaskId} AND w.work_kind = 'check' AND w.status = 'Completed'
      ORDER BY w.created_at, w.id`);
    return z.array(z.object({ id: z.string() })).parse(result.rows).map((row) => row.id);
  }

  /** The vision items a check task cites, as its task_spec stores them. */
  private async citedBy(checkTaskId: string): Promise<Array<z.infer<typeof citedItemSchema>>> {
    const result = await this.context.observer.execute(sql`SELECT task_spec->'sources' AS sources FROM work_items WHERE id = ${checkTaskId}`);
    const [row] = z.array(z.object({ sources: z.array(citedItemSchema).nullable() })).parse(result.rows);
    if (row === undefined) throw new StandInUnanswerable("suite-review", `check task ${checkTaskId} is not on record`);
    // eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a check task with no sources cites none; no oracle reads it
    return row.sources ?? [];
  }

  private answer(): unknown {
    return { verdict: "changes", statement: "Messages are in French.", kind: "undecided" };
  }

  private async latestChecks(projectId: string): Promise<Array<z.infer<typeof checkRowSchema>>> {
    const { observer } = this.context;
    const result = await observer.execute(sql`
      SELECT c.check_task_id AS "checkTaskId", c.task_id AS "taskId", c.revision, c.name, c.command, c.files
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
      SELECT id, project_id AS "projectId", title, task_spec AS "taskSpec", work_kind AS "workKind", dispatch_count AS "dispatchCount",
        infrastructure_faults AS "infrastructureFaults"
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
    // eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a call with no tools offers none; no oracle reads it
    const toolNames = new Set((options.tools ?? []).map((tool) => tool.name));
    // A requeue after a fault that was not the task's work refunds its dispatch, but its next
    // attempt is a new request to the model, so it draws a new script.
    const key = `${task.id}#${task.dispatchCount}#${task.infrastructureFaults}`;
    let script = this.attempts.get(key);
    if (script === undefined) {
      script = await this.scriptFor(task, toolNames, promptText(options));
      this.attempts.set(key, script);
    }
    const turn = assistantTurns(options);
    const step = script.steps[turn];
    const onModelCall = this.context.onModelCall;
    if (step !== undefined) {
      onModelCall({ site: "agent-runner", action: step[0] });
      return toolCall(++this.toolCalls, step[0], step[1]);
    }
    switch (script.end) {
      case "stall":
      case "stall-mid-edit":
        onModelCall({ site: "agent-runner", action: script.end });
        return toolCall(++this.toolCalls, "list_directory", { path: "." });
      case "truncated": {
        // Cut while writing its next call: the call's input is half a JSON text.
        onModelCall({ site: "agent-runner", action: "truncated" });
        const [toolName, input] = script.cut ?? ["finish", { status: "done", summary: "Done." }];
        const content: LanguageModelV4Content[] = [
          { type: "text", text: "Next I write the change." },
          { type: "tool-call", toolCallId: `sim-call-${++this.toolCalls}`, toolName, input: firstHalf(JSON.stringify(input)) },
        ];
        return cutAtBound(content, outputBoundOf(options));
      }
      case "empty":
        onModelCall({ site: "agent-runner", action: "empty" });
        return EMPTY;
      case "reasoning-exhausted":
        onModelCall({ site: "agent-runner", action: "reasoning-exhausted" });
        return reasoningOnly(outputBoundOf(options));
      case "refusal":
      case "complete":
        onModelCall({ site: "agent-runner", action: script.end === "refusal" ? "refusal" : "no-more-steps" });
        return REFUSAL;
    }
  }

  private async scriptFor(task: z.infer<typeof taskRowSchema>, tools: ReadonlySet<string>, prompt: string): Promise<AttemptScript> {
    const { tape, rates } = this.context;
    const spec = taskSpecShape.safeParse(task.taskSpec);
    const origin = spec.success ? spec.data.origin : undefined;
    let steps: ToolStep[];
    let work: WorkKind;
    if (tools.has("build_environment")) {
      work = "environment";
      steps = this.environmentWork();
    } else if (tools.has("define_check")) {
      work = "checks";
      // eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a task spec with no sources cites none; no oracle reads it
      steps = await this.checkWork(spec.success ? spec.data.checksFor : undefined, spec.success ? (spec.data.sources ?? []).map((item) => item.id) : []);
    } else if (origin === "product-scaffold") {
      work = "scaffold";
      steps = [["write_file", { path: LAYOUT_FILE, content: "behaviours/\n" }], ...this.publicInterfaceWork(task.projectId), finished("Set up the product layout.")];
    } else if (isInterfaceTaskTitle(task.title)) {
      work = "implementation";
      const form = this.interfaceForms.get(task.projectId) ?? "short";
      steps = [["write_file", { path: PUBLIC_INTERFACE_PATH, content: deliveredInterfaceText(form) }], finished(`Updated ${PUBLIC_INTERFACE_PATH}.`)];
    } else {
      work = "implementation";
      steps = await this.implementationWork(task, tools, conflictFilesOf(prompt));
    }
    if (tape.chance("agent.timeout", rates.timeout, work)) return { steps: steps.slice(0, -1), end: "stall", cut: null };
    if (tape.chance("agent.refusal", rates.refusal, work)) return { steps: steps.slice(0, -1), end: "refusal", cut: null };
    return this.misbehaved(steps, work);
  }

  /**
   * The attempt as the profile's response-level misbehaviour leaves it, or as scripted. The last
   * step ends the attempt (finish, dispute), so every cut lands before it:
   * - the turn cap after some of the steps and before the rest (work left uncommitted);
   * - one turn cut at the output limit mid tool call, empty, or all reasoning, where the attempt's
   *   steps would have gone on.
   */
  private misbehaved(steps: ToolStep[], work: WorkKind): AttemptScript {
    const { tape, rates } = this.context;
    const edits = steps.length - 1;
    if (edits >= 1 && tape.chance("agent.turn-cap-mid-edit", rates.turnCapMidEdit, work)) {
      return { steps: steps.slice(0, 1 + tape.pick("agent.turn-cap-mid-edit.after", edits, work)), end: "stall-mid-edit", cut: null };
    }
    const end: AttemptEnd | null = tape.chance("agent.truncated-turn", rates.truncatedTurn, work)
      ? "truncated"
      : tape.chance("agent.empty-turn", rates.emptyTurn, work)
        ? "empty"
        : tape.chance("agent.reasoning-exhausted", rates.reasoningExhausted, work)
          ? "reasoning-exhausted"
          : null;
    if (end === null) return { steps, end: "complete", cut: null };
    const at = tape.pick("agent.misbehaving-turn", steps.length, work);
    return { steps: steps.slice(0, at), end, cut: end === "truncated" ? (steps[at] ?? null) : null };
  }

  /** The scaffold's public interface file: written as briefed, left out, or longer than any report quotes whole. */
  private publicInterfaceWork(projectId: string): ToolStep[] {
    const pick = this.context.tape.pick("agent.scaffold.public-interface", 3, "scaffold");
    const form: InterfaceForm | null = pick === 1 ? null : pick === 0 ? "short" : "oversized";
    this.interfaceForms.set(projectId, form);
    if (form === null) return [];
    return [["write_file", { path: PUBLIC_INTERFACE_PATH, content: publicInterfaceText(form) }]];
  }

  /**
   * An implementation updates the scaffold's public interface file, as its charter asks, unless it
   * leaves it stale (the profile's rate); with no file from the scaffold there is none to update.
   */
  private interfaceUpdate(projectId: string): ToolStep[] {
    const form = this.interfaceForms.get(projectId) ?? null;
    if (form === null) return [];
    if (this.context.tape.chance("agent.interface-left-stale", this.context.rates.interfaceLeftStale, "implementation")) return [];
    return [["write_file", { path: PUBLIC_INTERFACE_PATH, content: deliveredInterfaceText(form) }]];
  }

  private environmentWork(): ToolStep[] {
    const defect = this.context.tape.chance("agent.recipe-defect", this.context.rates.recipeDefect, "environment");
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

  /**
   * A check task's turns. Each check names the cited items it decides (ADR-083): a behaviour's check
   * decides its scope line, and every cited item no such check decides gets a check of its own, so the
   * set decides every item its task cites, as an honest author writes it.
   */
  private async checkWork(checksFor: string | undefined, cited: readonly string[]): Promise<ToolStep[]> {
    const { tape, rates, universe } = this.context;
    if (checksFor === undefined) throw new StandInUnanswerable("agent-runner", "a check task names no task it checks");
    const [firstCited] = cited;
    if (firstCited === undefined) throw new StandInUnanswerable("agent-runner", `the check task for ${checksFor} cites no vision item`);
    const checkedTitle = await this.titleOf(checksFor);
    if (isInterfaceTaskTitle(checkedTitle)) {
      const path = `checks/${checksFor}/interface.json`;
      const spec: CheckSpec = { kind: "interface", requires: [], forbids: [], harness: [] };
      return [
        ["write_file", { path, content: `${JSON.stringify(spec)}\n` }],
        ["define_check", { name: "interface", command: `sim check ${path}`, decides: cited }],
        finished("Defined 1 check(s)."),
      ];
    }
    const checked = taskOfTitle(universe, checkedTitle);
    if (checked === null) throw new StandInUnanswerable("agent-runner", `check task for ${checksFor}: its title carries no simulator marker`);
    const decidedBy = (b: string): readonly string[] => {
      const line = `S${universe.behaviours.indexOf(b) + 1}`;
      return cited.includes(line) ? [line] : [firstCited];
    };
    const checks: Array<{ readonly name: string; readonly spec: CheckSpec; readonly decides: readonly string[] }> = checked.behaviours.map((b) => ({
      name: `has-${b}`,
      spec: { kind: "correct", requires: [b], forbids: [], harness: [] },
      decides: decidedBy(b),
    }));
    for (const id of cited.filter((each) => !checks.some((check) => check.decides.includes(each)))) {
      checks.push({ name: `holds-${id}`, spec: { kind: "correct", requires: [...checked.behaviours], forbids: [], harness: [] }, decides: [id] });
    }
    const other = universe.tasks.find((t) => t.ref !== checked.ref);
    const extra = (name: string, spec: CheckSpec): void => void checks.push({ name, spec, decides: [firstCited] });
    if (tape.chance("agent.check.wrong", rates.wrongCheck, "checks")) extra("wrong", { kind: "wrong", requires: ["b-never"], forbids: [], harness: [] });
    if (other !== undefined && tape.chance("agent.check.contradictory", rates.contradictoryCheck, "checks")) {
      extra("contradicts", { kind: "contradictory", requires: [], forbids: [...other.behaviours], harness: [] });
    }
    if (tape.chance("agent.check.vacuous", rates.vacuousCheck, "checks")) extra("vacuous", { kind: "vacuous", requires: [], forbids: [], harness: [] });
    if (tape.chance("agent.check.out-of-vision", rates.outOfVisionCheck, "checks")) {
      extra("extra", { kind: "out_of_vision", requires: [universe.outOfVision], forbids: [], harness: [] });
    }
    if (tape.chance("agent.check.flaky", rates.flakyCheck, "checks")) extra("flaky", { kind: "flaky", requires: [...checked.behaviours], forbids: [], harness: [] });
    if (tape.chance("agent.check.unrunnable", rates.unrunnableCheck, "checks")) {
      extra("unrunnable", { kind: tape.pick("agent.check.unrunnable-kind", 2, "checks") === 0 ? "unrunnable" : "slow", requires: [], forbids: [], harness: [] });
    }
    if (tape.chance("agent.check.harness", rates.flakyCheck, "checks")) {
      extra("harness", { kind: "correct", requires: [...checked.behaviours], forbids: [], harness: [{ path: `product/harness/${checked.ref}`, content: "harness\n" }] });
    }
    const sticky = this.stickyBadCheck(checksFor, other);
    if (sticky !== null) extra(`sticky-${sticky.kind}`, sticky);
    const allGuard = tape.chance("agent.check.all-guard", rates.allGuardSet, "checks");
    const kept = allGuard ? checks.map((check) => ({ ...check, spec: { ...check.spec, kind: "vacuous" as const } })) : checks;
    const steps: ToolStep[] = [];
    for (const check of kept) {
      // The checks directory the brief names (checkAreaOf): the checked task's id, not the simulator's ref.
      const path = `checks/${checksFor}/${check.name}.json`;
      steps.push(["write_file", { path, content: `${JSON.stringify(check.spec)}\n` }]);
      steps.push(["define_check", { name: check.name, command: `sim check ${path}`, decides: check.decides }]);
    }
    // The author also writes the product it checks, in its own workspace.
    if (tape.chance("agent.check.writes-product", rates.authorWritesProduct, "checks")) {
      for (const b of checked.behaviours) steps.push(["write_file", { path: behaviourPath(b), content: `${b} by the check author\n` }]);
    }
    steps.push(finished(`Defined ${kept.length} check(s).`));
    return steps;
  }

  /**
   * The bad check a sticky-bad check author writes for `checksFor`: none until its persona first
   * fires on that task's checks, then the same one on every rewrite of them. A contradiction needs
   * another task to forbid the behaviours of; without one the author writes a wrong check.
   */
  private stickyBadCheck(checksFor: string, other: SimTask | undefined): CheckSpec | null {
    const { personas, tape, universe, onModelCall } = this.context;
    if (personas.of("check-author") !== "sticky-bad") return null;
    if (!this.stickyBad.has(checksFor)) {
      if (!personas.fires("check-author")) return null;
      this.stickyBad.add(checksFor);
    }
    this.stickyKind ??= nthOf(STICKY_KINDS, tape.pick("persona.check-author.kind", STICKY_KINDS.length, "checks"));
    const kind: StickyKind = this.stickyKind === "contradictory" && other === undefined ? "wrong" : this.stickyKind;
    onModelCall({ site: "agent-runner", action: `persona sticky-bad: writes a ${kind} check again` });
    switch (kind) {
      case "contradictory":
        // eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, the contradictory kind is only chosen with another task (above); no oracle reads it
        return { kind, requires: [], forbids: [...(other?.behaviours ?? [])], harness: [] };
      case "wrong":
        return { kind, requires: ["b-never"], forbids: [], harness: [] };
      case "out_of_vision":
        return { kind, requires: [universe.outOfVision], forbids: [], harness: [] };
    }
  }

  /**
   * An implementation's turns. Handed a conflict with main (`conflicted`, the files its brief
   * names), it first resolves each by keeping both sides (`sim resolve`), or leaves one's markers
   * in, and never writes a conflicted file over its resolution afterwards.
   */
  private async implementationWork(task: z.infer<typeof taskRowSchema>, tools: ReadonlySet<string>, conflicted: readonly string[]): Promise<ToolStep[]> {
    const { tape, rates, universe } = this.context;
    const mine = taskOfTitle(universe, task.title);
    if (mine === null) throw new StandInUnanswerable("agent-runner", `implementation ${task.id} "${task.title}" carries no simulator marker`);
    const index = universe.tasks.indexOf(mine);
    const steps: ToolStep[] = [];
    for (const file of conflicted) {
      const leaves = tape.chance("agent.conflict.markers-left", rates.conflictMarkersLeft, "implementation");
      this.context.onModelCall({ site: "agent-runner", action: `handed a conflict in ${file}: ${leaves ? "leaves its markers" : "resolves it"}` });
      if (!leaves) steps.push(["run_command", { command: `sim resolve ${file}` }]);
    }
    let behaviours = [...mine.behaviours];
    const underDelivers = behaviours.length > 0 && tape.chance("agent.under-delivery", rates.underDelivery, "implementation");
    if (underDelivers) behaviours = behaviours.slice(0, -1);
    const later: SimTask[] = universe.tasks.slice(index + 1);
    // eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a later task with no behaviours adds none; no oracle reads it
    if (later.length > 0 && tape.chance("agent.over-delivery", rates.overDelivery, "implementation")) behaviours.push(...(later[0]?.behaviours ?? []));
    for (const b of behaviours) steps.push(["write_file", { path: behaviourPath(b), content: `${b}\n` }]);
    const earlier = universe.tasks.slice(0, index).flatMap((t) => t.behaviours);
    const victim = earlier[0];
    if (victim !== undefined && tape.chance("agent.regression", rates.regression, "implementation")) {
      steps.push(["run_command", { command: `sim rm ${behaviourPath(victim)}` }]);
    }
    if (!conflicted.includes(PUBLIC_INTERFACE_PATH)) steps.push(...this.interfaceUpdate(task.projectId));
    if (tape.chance("agent.manifest", rates.overDelivery / 3, "implementation") && !conflicted.includes(MANIFEST_FILE)) {
      steps.push(["write_file", { path: MANIFEST_FILE, content: `${mine.ref}\n` }]);
    }
    // One file two tasks of a batch both write, so the second merge conflicts.
    if (tape.chance("agent.shared-file", rates.sharedFileEdit, "implementation") && !conflicted.includes(SHARED_INDEX_FILE)) {
      steps.push(["write_file", { path: SHARED_INDEX_FILE, content: `${mine.ref}: ${behaviours.join(", ")}\n` }]);
    }
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
        if (bad && tape.chance("agent.dispute.right", rates.disputeRight, "implementation")) {
          return { name: row.name, reason: `The check ${spec.kind === "out_of_vision" ? "asks for behaviour the vision does not name" : "cannot pass on correct work"}.` };
        }
        if (!bad && underDelivered && tape.chance("agent.dispute.wrong", rates.disputeWrong, "implementation")) {
          return { name: row.name, reason: "The check is too strict." };
        }
      }
    }
    return null;
  }
}

/** `list[at]`, where the tape drew `at` from `list.length`. */
function nthOf<T>(list: readonly T[], at: number): T {
  const value = list[at];
  if (value === undefined) throw new StandInUnanswerable("persona", `the tape drew ${at} from a list of ${list.length}`);
  return value;
}

function finished(summary: string): ToolStep {
  return ["finish", { status: "done", summary }];
}

/** The check specs a stored check's files hold; a file that is not one is skipped. */
/** The spec of one stored check: the spec file its command runs, or null when it runs none. */
function ownSpecOf(row: z.infer<typeof checkRowSchema>): CheckSpec | null {
  const [spec] = specsOf(row.files.filter((file) => row.command.endsWith(` ${file.path}`)));
  return spec === undefined ? null : spec;
}

function requiresAny(spec: CheckSpec | null, behaviours: readonly string[]): boolean {
  return spec !== null && spec.requires.some((behaviour) => behaviours.includes(behaviour));
}

function specsOf(files: ReadonlyArray<{ readonly path: string; readonly content: string }>): CheckSpec[] {
  const specs: CheckSpec[] = [];
  for (const file of files) {
    if (!file.path.endsWith(".json")) continue;
    let raw: unknown;
    try {
      // eslint-disable-next-line no-restricted-syntax -- a stand-in model may import no product package (boundary-rules.toml stand-ins), so it cannot reach parseJson; CheckSpecSchema validates the value below
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

import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { z } from "zod";
import { isInterfaceTaskTitle } from "../product.js";
import { CheckAuthorStandIn } from "./check-author.js";
import type { StandInContext, TaskRow } from "./context.js";
import { taskInProgress } from "./context.js";
import { ImplementerStandIn } from "./implementer.js";
import { environmentWork } from "./platform.js";
import { conflictFilesOf } from "./recognised-wording.js";
import {
  EMPTY,
  REFUSAL,
  assistantTurns,
  contextOverflow,
  cutAtBound,
  firstHalf,
  outputBoundOf,
  promptText,
  reasoningOnly,
  toolCall,
} from "./responses.js";
import type { ToolStep } from "./tool-steps.js";

const taskSpecShape = z.object({
  origin: z.string().optional(),
  checksFor: z.string().optional(),
  sources: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
});

/**
 * What the first turn past an attempt's scripted steps answers:
 * - complete: its steps end the attempt (finish, dispute); a turn past them is refused;
 * - refusal: a refusal (content filter), no tool call;
 * - stall: lists the workspace every turn until the attempt's turn cap ends it;
 * - stall-mid-edit: the same, after only some of its edits (the trace tells the two apart);
 * - truncated: the turn is cut at the output limit while writing its next tool call;
 * - empty: the turn has no content at all;
 * - reasoning-exhausted: the turn's whole output bound goes to reasoning, no content;
 * - context-overflow: the provider rejects the turn as longer than the model's context window.
 */
type AttemptEnd =
  | "complete"
  | "refusal"
  | "stall"
  | "stall-mid-edit"
  | "truncated"
  | "empty"
  | "reasoning-exhausted"
  | "context-overflow";

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
 * An agent's turns, whatever role the attempt's tools and task show it works as: an agent turn reads
 * its task from the lane making the call rather than parsing prompts, since the model port sees no
 * call context (projectId, taskId, callSite).
 */
export class AgentStandIn {
  private readonly attempts = new Map<string, AttemptScript>();
  private toolCalls = 0;
  private readonly checkAuthor: CheckAuthorStandIn;
  private readonly implementer: ImplementerStandIn;

  constructor(private readonly context: StandInContext) {
    this.checkAuthor = new CheckAuthorStandIn(context);
    this.implementer = new ImplementerStandIn(context);
  }

  async turn(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const task = await taskInProgress(this.context);
    await this.context.onAgentTurn({ id: task.id, projectId: task.projectId });
    /* eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a call with no tools
       offers none; no oracle reads it */
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
          {
            type: "tool-call",
            toolCallId: `sim-call-${++this.toolCalls}`,
            toolName,
            input: firstHalf(JSON.stringify(input)),
          },
        ];
        return cutAtBound(content, outputBoundOf(options));
      }
      case "empty":
        onModelCall({ site: "agent-runner", action: "empty" });
        return EMPTY;
      case "reasoning-exhausted":
        onModelCall({ site: "agent-runner", action: "reasoning-exhausted" });
        return reasoningOnly(outputBoundOf(options));
      case "context-overflow":
        onModelCall({ site: "agent-runner", action: "context-overflow" });
        throw contextOverflow(task.id);
      case "refusal":
      case "complete":
        onModelCall({ site: "agent-runner", action: script.end === "refusal" ? "refusal" : "no-more-steps" });
        return REFUSAL;
    }
  }

  private async scriptFor(task: TaskRow, tools: ReadonlySet<string>, prompt: string): Promise<AttemptScript> {
    const { tape, rates } = this.context;
    const spec = taskSpecShape.safeParse(task.taskSpec);
    const origin = spec.success ? spec.data.origin : undefined;
    let steps: ToolStep[];
    let work: WorkKind;
    if (tools.has("build_environment")) {
      work = "environment";
      steps = environmentWork(this.context);
    } else if (tools.has("define_check")) {
      work = "checks";
      steps = await this.checkAuthor.checkWork(
        spec.success ? spec.data.checksFor : undefined,
        /* eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a task spec with no
           sources cites none; no oracle reads it */
        spec.success ? (spec.data.sources ?? []) : [],
      );
    } else if (origin === "product-scaffold") {
      work = "scaffold";
      steps = this.implementer.scaffoldWork(task.projectId);
    } else if (isInterfaceTaskTitle(task.title)) {
      work = "implementation";
      steps = this.implementer.interfaceTaskWork(task.projectId);
    } else {
      work = "implementation";
      steps = await this.implementer.implementationWork(task, tools, conflictFilesOf(prompt));
    }
    if (tape.chance("agent.timeout", rates.timeout, work))
      return { steps: steps.slice(0, -1), end: "stall", cut: null };
    if (tape.chance("agent.refusal", rates.refusal, work))
      return { steps: steps.slice(0, -1), end: "refusal", cut: null };
    return this.misbehaved(steps, work);
  }

  /**
   * The attempt as the profile's response-level misbehaviour leaves it, or as scripted. The last
   * step ends the attempt (finish, dispute), so every cut lands before it:
   * - the turn cap after some of the steps and before the rest (work left uncommitted);
   * - one turn cut at the output limit mid tool call, empty, all reasoning, or rejected as longer than
   *   the model's context window, where the attempt's steps would have gone on.
   */
  private misbehaved(steps: ToolStep[], work: WorkKind): AttemptScript {
    const { tape, rates } = this.context;
    const edits = steps.length - 1;
    if (edits >= 1 && tape.chance("agent.turn-cap-mid-edit", rates.turnCapMidEdit, work)) {
      return {
        steps: steps.slice(0, 1 + tape.pick("agent.turn-cap-mid-edit.after", edits, work)),
        end: "stall-mid-edit",
        cut: null,
      };
    }
    const end: AttemptEnd | null = tape.chance("agent.truncated-turn", rates.truncatedTurn, work)
      ? "truncated"
      : tape.chance("agent.empty-turn", rates.emptyTurn, work)
        ? "empty"
        : tape.chance("agent.reasoning-exhausted", rates.reasoningExhausted, work)
          ? "reasoning-exhausted"
          : tape.chance("agent.context-overflow", rates.contextOverflow, work)
            ? "context-overflow"
            : null;
    if (end === null) return { steps, end: "complete", cut: null };
    const at = tape.pick("agent.misbehaving-turn", steps.length, work);
    return { steps: steps.slice(0, at), end, cut: end === "truncated" ? (steps[at] ?? null) : null };
  }
}

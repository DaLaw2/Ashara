import { z } from "zod";
import type { PlanningVision } from "./acl/engagement-acl.js";
import type { AbandonedTask, CorrectionRequest, PlannedItem, RevisionCause } from "./replan-port.js";
import { decisionOf } from "./revision-cause.js";

// The text a plan revision shows the planning model: what asked for the revision, the work already
// done, and the environment judgement's question.

/** Longest part of a given-up task's recorded failure the planner is shown. */
const MAX_ABANDONMENT_EVIDENCE_CHARS = 3000;

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[cut: ${text.length - max} of ${text.length} characters not shown]`;
}

/** The given-up tasks as the planner reads them: what was tried, how often, and why it failed. */
function abandonmentSection(abandoned: readonly AbandonedTask[]): string {
  return [
    `The team gave up ${abandoned.length === 1 ? "a task" : `${abandoned.length} tasks`} of the plan after its attempts failed:`,
    ...abandoned.map((task) => `- "${task.title}", after ${task.attempts} attempt(s). Evidence:\n${cut(task.evidence, MAX_ABANDONMENT_EVIDENCE_CHARS)}`),
  ].join("\n");
}

/** One change as the planner reads it: the client's words and what work now proceeds on. */
function changeLines(change: CorrectionRequest, vision: PlanningVision): string {
  return `The client wrote: ${change.words}\nWork now proceeds on:\n${decisionOf(change, vision)}`;
}

/** What the revision is asked for, as the planner reads it beside the vision items it plans. */
export function causeSection(cause: RevisionCause, vision: PlanningVision): string {
  if (cause.kind === "client-change") {
    const replanned =
      `Only the work these changes touch is planned again: the rest of the plan stands and goes on. ` +
      `Plan tasks for the vision items listed below, building on the work already done.`;
    return cause.changes.length === 1
      ? `The client changed what is built after work began. ${changeLines(cause.changes[0], vision)}\n${replanned}`
      : `The client changed what is built after work began, in ${cause.changes.length} messages; plan for every one of them.\n` +
          cause.changes.map((change, i) => `Change ${i + 1}. ${changeLines(change, vision)}`).join("\n") +
          `\n${replanned}`;
  }
  return (
    `${abandonmentSection(cause.abandoned)}\n` +
    `Plan the work still to do again so that the vision is still delivered: the given-up work is not done, and its ` +
    `evidence shows what to do differently. Plan small tasks, each a complete behaviour a user can use and observe.`
  );
}

/** The work already done, kept as the revision's context: titles and what merged them. */
export function doneSection(completed: readonly PlannedItem[]): string {
  if (completed.length === 0) return "Already done: nothing yet.";
  const lines = completed.map(({ item, mergeCommit }) =>
    mergeCommit === null ? `- ${item.title}` : `- ${item.title} (merged as ${mergeCommit})`,
  );
  return `Already done, and kept as it is (plan only what is still to do, building on it):\n${lines.join("\n")}`;
}

export const EnvironmentJudgmentSchema = z.strictObject({ environmentChange: z.boolean(), reason: z.string().min(1) });

export function environmentPrompt(cause: RevisionCause, statement: string | null, vision: PlanningVision): string {
  const situation =
    cause.kind === "client-change"
      ? [
          `After work on a project began, the client changed what is built.`,
          `Say whether ${cause.changes.length === 1 ? "this change" : `what the client changed, in ${cause.changes.length} messages taken together,`} needs the project environment changed: how the project is built and tested, the`,
          `technology it is built with, or the tools its build and tests run on. A change to what the product does that`,
          `the environment as it is can build and test is not an environment change.`,
          ...cause.changes.flatMap((change) => [
            ``,
            `The client's words:`,
            JSON.stringify(change.words),
            ``,
            `What work now proceeds on:`,
            JSON.stringify(decisionOf(change, vision)),
          ]),
        ]
      : [
          `Work on a project stopped: the team gave up work after its attempts failed. Say whether the evidence shows`,
          `that the project environment must be changed for the remaining work to succeed: how the project is built and`,
          `tested, the technology it is built with, or the tools its build and tests run on (for example a build tool`,
          `that cannot write where the environment makes it write). A failure of the work itself is not an environment change.`,
          ``,
          abandonmentSection(cause.abandoned),
        ];
  return [
    `You are the planner of a software contractor.`,
    ...situation,
    ``,
    `The project environment, as the team stated it when it set it up:`,
    JSON.stringify(statement ?? "(no statement recorded)"),
    ``,
    `Return exactly {"environmentChange": true or false, "reason": "..."} with one sentence of reason.`,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
  ].join("\n");
}

export function judgmentReask(ctx: { readonly errors: readonly string[] }): string {
  return (
    `\n\nYour previous response was REJECTED for these reasons:\n` +
    ctx.errors.map((e) => `- ${e}`).join("\n") +
    `\nRe-send corrected JSON only. No markdown, no explanatory prose.`
  );
}

import { containEach } from "@ashara/shared";
import type { ProjectId, StepContainment, StepFaulted, UnreadSubject } from "@ashara/shared";

// The Liaison's receipt for every message the client sends. A message is never left unanswered,
// whatever state its project is in: each inbound message gets one receipt, posted in reply to it the
// cycle the Liaison first sees it, stating the project's state and what happens to the message and
// when. The receipt comes before what the message's own reader replies (an impact note, a stop
// report), which it announces; it is never the reading itself, so it consumes nothing a reader acts
// on. Only a message to a closed project (stopped or delivered) is consumed with its receipt: nothing
// acts on it, and the receipt says so.

/** What the client can send. */
type InboundKind = "tender" | "answer" | "change" | "stop";

/**
 * The project's state as the receipt tells it: at work, paused by a halt (its recorded kind, and
 * whether answers and changes are still read under it), stopped by the client, or delivered.
 */
export type ProjectStanding =
  | { readonly kind: "at-work" }
  | { readonly kind: "paused"; readonly halt: string; readonly readsInput: boolean }
  | { readonly kind: "stopped" }
  | { readonly kind: "accepted" };

/**
 * Whether Ashara's rounds of work run: "stopped" once the deployment's spend cap is reached, when
 * no round of work, and no model call that reads a message, runs again until the owner raises the
 * cap and the process starts again.
 */
type DeploymentWork = { readonly kind: "running" } | { readonly kind: "stopped-at-cap" };

/** An inbound message with no receipt yet. */
export interface DueReceipt {
  readonly messageId: string;
  readonly projectId: ProjectId;
  readonly kind: InboundKind;
  /** Whether a reader has consumed it already. */
  readonly consumed: boolean;
  /** On a stop: whether it is the stop that moved its project to 'stopped'. */
  readonly stoppedProject: boolean;
  readonly standing: ProjectStanding;
}

/** A receipt to post: its body, and whether the message is consumed with it (a closed project's). */
interface ReceiptWrite {
  readonly due: DueReceipt;
  readonly body: string;
  readonly closes: boolean;
}

/** Engagement's persistence port for receipts. */
export interface ClientReceiptStore {
  /** Every inbound message owed a receipt, oldest first; one whose rows do not read is its UnreadSubject. */
  dueReceipts(): Promise<ReadonlyArray<DueReceipt | UnreadSubject>>;
  /**
   * Posts the receipt in reply to its message, and consumes the message when it `closes`, in one
   * transaction; once per message. A message whose project's state or whose consumption moved since
   * it was listed gets nothing ("moved"), and is listed again next cycle.
   */
  postReceipt(write: ReceiptWrite): Promise<"posted" | "already-posted" | "moved">;
}

interface ClientReceiptOutcome {
  readonly kind: "posted" | "already-posted" | "moved";
  readonly messageId: string;
  readonly projectId: ProjectId;
}

/** What the core loop asks of the Liaison every cycle, at the spend cap too (no LLM call). */
export interface LiaisonClientReceipts {
  runPending(work: DeploymentWork): Promise<ReadonlyArray<ClientReceiptOutcome | StepFaulted>>;
}

const NOUN: Readonly<Record<InboundKind, string>> = {
  tender: "tender",
  answer: "answer",
  change: "change",
  stop: "request to stop the work",
};

const ALL_WORK_STOPPED = "Ashara has stopped all work: the spending limit set for the whole deployment is reached.";

/** A project that is not closed, while every round of work is stopped at the deployment's cap. */
function openWhileStopped(standing: ProjectStanding, work: DeploymentWork): boolean {
  return work.kind === "stopped-at-cap" && (standing.kind === "at-work" || standing.kind === "paused");
}

function standingLine(standing: ProjectStanding, work: DeploymentWork): string {
  if (openWhileStopped(standing, work)) {
    return standing.kind === "paused"
      ? `Work on this project is paused, for the reason Ashara's report of the pause gives, and that pause still has to end before work on it resumes. ${ALL_WORK_STOPPED}`
      : ALL_WORK_STOPPED;
  }
  switch (standing.kind) {
    case "at-work":
      return "This project is at work.";
    case "paused":
      return "Work on this project is paused, for the reason Ashara's report of the pause gives.";
    case "stopped":
      return "Work on this project has stopped at your request, and Ashara does no further work on it.";
    case "accepted":
      return "This project is delivered: its final check passed on the project's main line, and the project is closed.";
  }
}

/** What ends a pause: only the substrate probe for an infrastructure halt, the operator's resumption for every other. */
function pauseEnd(halt: string): string {
  return halt === "infrastructure"
    ? "Ashara resumes the project by itself as soon as the machines it runs the work on answer again, and you will be told when it does."
    : "The pause ends when the team's operator resumes the project, and you will be told when it does.";
}

/** What reading the message leads to, once it is read. */
function afterReading(kind: Exclude<InboundKind, "stop">): string {
  switch (kind) {
    case "tender":
      return "and replies with its understanding of what you asked for and any questions it has";
    case "answer":
      return "and, if it changes what the plan rests on, the work that rests on it is planned again and you are told what changes";
    case "change":
      return "and replies with what it changes, the work it touches and what that costs";
  }
}

function stopFate(due: DueReceipt): string {
  if (due.standing.kind === "stopped") {
    return due.consumed && due.stoppedProject
      ? "Your request is taken: the report of the stop, with what is on record as merged, follows."
      : "The project was already stopped, so this request changes nothing.";
  }
  if (due.consumed) return "Your request was taken when it arrived; the project has since been returned to work.";
  return "No new work starts on this project from now on, and Ashara takes the stop in at the start of its next round of work.";
}

/**
 * Why a paused project's message waits for the pause's end, by the halt that holds it
 * (projectReadsClientInput): a budget halt refuses the reading's model call, and a halt on a model's or
 * its provider's failure would meet the reading's model call too.
 */
function unreadWhilePaused(halt: string): string {
  switch (halt) {
    case "budget_cap":
    case "work_budget":
      return "Reading it takes model work, which the budget that paused this project does not allow, so Ashara reads it once the pause ends.";
    case "model_failed":
    case "provider_failed":
    case "replan_stopped":
    case "replan_provider_failed":
      return "Reading it takes model work, and what paused this project is model work failing, so Ashara reads it once the pause ends rather than while it lasts.";
    default:
      return "Ashara reads it once the pause ends.";
  }
}

function messageFate(due: DueReceipt & { readonly kind: Exclude<InboundKind, "stop"> }, work: DeploymentWork): string {
  const { standing } = due;
  if (due.consumed) return "It has been read and taken into the project's record.";
  if (openWhileStopped(standing, work)) {
    return "It is recorded, and nothing reads it while all work is stopped: Ashara reads it once the owner raises that limit and Ashara is started again.";
  }
  switch (standing.kind) {
    case "stopped":
    case "accepted":
      return `It is recorded, but not acted on: Ashara does no further work on a ${standing.kind === "stopped" ? "stopped" : "delivered"} project.`;
    case "at-work":
      return `Ashara reads it in this or the next round of work, ${afterReading(due.kind)}.`;
    case "paused":
      if (due.kind === "tender") return "Ashara reads it once the pause ends.";
      if (!standing.readsInput) return unreadWhilePaused(standing.halt);
      // A paused project at its own spend limit has the reading's model call refused; the reading waits for the limit.
      return (
        `Ashara reads it all the same, in this or the next round of work, ${afterReading(due.kind)}, unless this project has ` +
        `reached its own spending limit, in which case it is read once that limit is raised. ` +
        `This ${NOUN[due.kind]} does not end the pause: the work it touches is planned for it once work resumes.`
      );
  }
}

/** The receipt: that the message arrived, the project's state, and what happens to the message and when. */
function receiptReport(due: DueReceipt, work: DeploymentWork): string {
  const fate = due.kind === "stop" ? stopFate(due) : messageFate({ ...due, kind: due.kind }, work);
  // While all work is stopped nothing ends a pause by itself, so its usual end is not promised.
  const end = due.standing.kind === "paused" && due.kind !== "stop" && !openWhileStopped(due.standing, work) ? [pauseEnd(due.standing.halt)] : [];
  return [`Ashara has received your ${NOUN[due.kind]}.`, standingLine(due.standing, work), fate, ...end].join("\n\n");
}

/** A message to a closed project that no reader consumed: nothing will act on it, so its receipt consumes it. A stop is the stop step's alone. */
function closesMessage(due: DueReceipt): boolean {
  return !due.consumed && due.kind !== "stop" && (due.standing.kind === "stopped" || due.standing.kind === "accepted");
}

export class ClientReceipts implements LiaisonClientReceipts {
  constructor(
    private readonly store: ClientReceiptStore,
    /** Each receipt's own fault is contained to it (containEach). */
    private readonly containment: StepContainment,
  ) {}

  /** Every receipt due, each posted once; one that cannot be read or posted is contained to it (containEach). */
  async runPending(work: DeploymentWork): Promise<ReadonlyArray<ClientReceiptOutcome | StepFaulted>> {
    return containEach(
      this.containment,
      "client-receipt",
      await this.store.dueReceipts(),
      (due) => ({ id: receiptSubject(due.messageId), projectId: due.projectId }),
      async (due): Promise<ClientReceiptOutcome> => {
        const kind = await this.store.postReceipt({ due, body: receiptReport(due, work), closes: closesMessage(due) });
        return { kind, messageId: due.messageId, projectId: due.projectId };
      },
    );
  }
}

/** The subject a receipt's faults are kept under, the same in its listing and its step. */
export function receiptSubject(messageId: string): string {
  return `receipt:${messageId}`;
}

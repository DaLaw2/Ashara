import type { HaltKind } from "@ashara/delivery/predicates";
import { UnreadSubject, containEach } from "@ashara/shared";
import type { ProjectId, StepContainment, StepFaulted } from "@ashara/shared";
import { WAITS_FOR_HALT_END, inboundDecision } from "./inbound-policy.js";
import type { InboundKind, InboundState, Told } from "./inbound-policy.js";
import { NOTHING_VERIFIABLE } from "./vision-language/guarantee.js";
import type { ContractStanding } from "./vision-language/guarantee.js";
import { WORK_WORDS } from "./vision-language/work-promise.js";

// The Liaison's receipt for every message the client sends. A message is never left unanswered,
// whatever state its project is in: each inbound message gets one receipt, posted in reply to it the
// cycle the Liaison first sees it, stating the project's state and what happens to the message and
// when. The receipt comes before what the message's own reader replies (an impact note, a stop
// report), which it announces; it is never the reading itself, so it consumes nothing a reader acts
// on. Only a message to a closed project (stopped or delivered) is consumed with its receipt: nothing
// acts on it, and the receipt says so.

/**
 * The project's state as the receipt tells it: at work, paused by a halt of its recorded kind,
 * stopped by the client, or delivered; while it is open, whether its tender's reading has written
 * its first vision, which a change waits for, and the standing of the contract in force, which
 * decides what the receipt says of the work (WORK_WORDS); a held one's receipt ends with the decline.
 */
export type ProjectStanding =
  | { readonly kind: "at-work"; readonly visionWritten: boolean; readonly contract: Exclude<ContractStanding, "unread"> }
  | { readonly kind: "paused"; readonly halt: HaltKind; readonly visionWritten: boolean; readonly contract: Exclude<ContractStanding, "unread"> }
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
  /** The subject of every message owed a receipt now, posted or not (no LLM call, nothing written). */
  dueMessages(): Promise<ReadonlySet<string>>;
}

const NOUN: Readonly<Record<InboundKind, string>> = {
  tender: "tender",
  answer: "answer",
  change: "change",
  stop: "request to stop the work",
};

const ALL_WORK_STOPPED = "Ashara has stopped all work: the spending limit set for the whole deployment is reached.";

/**
 * The standing of the contract in force on an open project, which every sentence the receipt says of
 * the work follows; a closed project has no work to promise, so it reads as one with none promised.
 */
function contractOf(standing: ProjectStanding): ContractStanding {
  return standing.kind === "at-work" || standing.kind === "paused" ? standing.contract : "unread";
}

/** A project that is not closed, while every round of work is stopped at the deployment's cap. */
function openWhileStopped(standing: ProjectStanding, work: DeploymentWork): boolean {
  return work.kind === "stopped-at-cap" && (standing.kind === "at-work" || standing.kind === "paused");
}

function standingLine(standing: ProjectStanding, work: DeploymentWork): string {
  const words = WORK_WORDS[contractOf(standing)];
  if (openWhileStopped(standing, work)) {
    if (standing.kind !== "paused") return ALL_WORK_STOPPED;
    return `${words.pausedFor}, and that pause still has to end${words.before("work on it resumes")}. ${ALL_WORK_STOPPED}`;
  }
  switch (standing.kind) {
    case "at-work":
      return words.atWork;
    case "paused":
      return `${words.pausedFor}.`;
    case "stopped":
      return "Work on this project has stopped at your request, and Ashara does no further work on it.";
    case "accepted":
      return "This project is delivered: its final check passed on the project's main line, and the project is closed.";
  }
}

/**
 * What ends a pause: only the substrate probe for an infrastructure halt, the client's answer for a
 * client_wait halt, the operator for every other; what follows, as the contract's standing allows.
 */
function pauseEnd(halt: HaltKind, standing: ContractStanding): string {
  const words = WORK_WORDS[standing];
  switch (halt) {
    case "infrastructure":
      return `Ashara ${words.machinesEnd("the machines it runs the work on answer again")}, and you will be told when it does.`;
    case "client_wait":
      return "The pause ends once your answer to the question the team asked you is read, and you will be told when it does.";
    default:
      return `The pause ends when the team's operator ${words.operatorEnds}, and you will be told when it does.`;
  }
}

/** What reading the message leads to, once it is read, as the contract's standing allows. */
function afterReading(kind: Exclude<InboundKind, "stop">, standing: ContractStanding): string {
  switch (kind) {
    case "tender":
      return "and replies with its understanding of what you asked for and any questions it has";
    case "answer":
      return WORK_WORDS[standing].answerRead;
    case "change":
      return WORK_WORDS[standing].changeRead;
  }
}

function stopFate(due: DueReceipt): string {
  if (due.standing.kind === "stopped") {
    return due.consumed && due.stoppedProject
      ? "Your request is taken: the report of the stop, with what is on record as merged, follows."
      : "The project was already stopped, so this request changes nothing.";
  }
  if (due.consumed) return `Your request was taken when it arrived; ${WORK_WORDS[contractOf(due.standing)].reopened}`;
  return "No new work starts on this project from now on, and Ashara takes the stop in at the start of its next round of work.";
}

/** The project's state as inboundDecision reads it. */
function inboundState(standing: ProjectStanding): InboundState {
  switch (standing.kind) {
    case "at-work":
      return { lifecycle: "active", halt: null, visionWritten: standing.visionWritten };
    case "paused":
      return { lifecycle: "active", halt: standing.halt, visionWritten: standing.visionWritten };
    case "stopped":
      return { lifecycle: "stopped" };
    case "accepted":
      return { lifecycle: "accepted" };
  }
}

/** A message that is not a stop was decided to be told the stop's account: the decision does not hold together. */
class ReceiptToldIncoherent extends Error {
  constructor(
    readonly messageId: string,
    readonly kind: InboundKind,
    readonly told: Told,
  ) {
    super(`the receipt for client message ${messageId}, a ${kind}, was decided to tell '${told}', which only a stop is told`);
    this.name = "ReceiptToldIncoherent";
  }
}

function messageFate(due: DueReceipt & { readonly kind: Exclude<InboundKind, "stop"> }, work: DeploymentWork): string {
  const { standing } = due;
  if (due.consumed) return "It has been read and taken into the project's record.";
  if (openWhileStopped(standing, work)) {
    return "It is recorded, and nothing reads it while all work is stopped: Ashara reads it once the owner raises that limit and Ashara is started again.";
  }
  const told = inboundDecision(inboundState(standing), due.kind).told;
  const words = WORK_WORDS[contractOf(standing)];
  const after = afterReading(due.kind, contractOf(standing));
  switch (told) {
    case "closed":
      return `It is recorded, but not acted on: Ashara does no further work on a ${standing.kind === "stopped" ? "stopped" : "delivered"} project.`;
    case "read-at-work":
      return `Ashara reads it in this or the next round of work, ${after}.`;
    case "waits-for-tender":
      return `Ashara reads it once it has read the tender this project began with, ${after}.`;
    case "waits-for-pause":
      return "Ashara reads it once the pause ends.";
    case "waits-for-budget":
      return WAITS_FOR_HALT_END.budget;
    case "waits-for-model-work":
      return WAITS_FOR_HALT_END["model-work"];
    case "read-during-pause":
      // A paused project at its own spend limit has the reading's model call refused; the reading waits for the limit.
      // A reading that fails on every attempt, or a message the record cannot take while paused, waits for the
      // pause's end, whose every exit sets its count of failed readings back to none (inboundDecision's resetOnHaltEnd).
      return (
        `Ashara reads it all the same, in this or the next round of work, ${after}, unless this project has ` +
        `reached its own spending limit, in which case it is read once that limit is raised. ` +
        `If reading it fails on every attempt, or the project's record cannot take it while the pause lasts, Ashara reads it afresh ${words.afterPause}. ` +
        `This ${NOUN[due.kind]} does not end the pause${words.workAfterPause === null ? "." : `: ${words.workAfterPause}.`}`
      );
    case "stop":
      throw new ReceiptToldIncoherent(due.messageId, due.kind, told);
  }
}

/**
 * The receipt: that the message arrived, the project's state, and what happens to the message and
 * when; on an open project whose contract Ashara declines, then the decline.
 */
function receiptReport(due: DueReceipt, work: DeploymentWork): string {
  const fate = due.kind === "stop" ? stopFate(due) : messageFate({ ...due, kind: due.kind }, work);
  // While all work is stopped nothing ends a pause by itself, so its usual end is not promised.
  const end = due.standing.kind === "paused" && due.kind !== "stop" && !openWhileStopped(due.standing, work) ? [pauseEnd(due.standing.halt, due.standing.contract)] : [];
  const declined = contractOf(due.standing) === "held" ? [NOTHING_VERIFIABLE] : [];
  return [`Ashara has received your ${NOUN[due.kind]}.`, standingLine(due.standing, work), fate, ...end, ...declined].join("\n\n");
}

/** A message no reader consumed and inboundDecision says is never read: nothing will act on it, so its receipt consumes it. */
function closesMessage(due: DueReceipt): boolean {
  return !due.consumed && inboundDecision(inboundState(due.standing), due.kind).reading === "never";
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

  async dueMessages(): Promise<ReadonlySet<string>> {
    return new Set((await this.store.dueReceipts()).map((due) => (due instanceof UnreadSubject ? due.id : receiptSubject(due.messageId))));
  }
}

/** The subject a receipt's faults are kept under, the same in its listing and its step. */
export function receiptSubject(messageId: string): string {
  return `receipt:${messageId}`;
}

import { containEach, createDomainEvent, type DomainEvent, type ProjectId, type StepContainment, type StepFaulted } from "@ashara/shared";

// The client's change of direction. Applying a change to a
// project under way is not built. Until it is, the Liaison does not leave a change unread:
// each cycle it consumes every open change and tells the client plainly, once, that it was received
// and kept but not applied, and that it can be sent as a new request. No LLM call: the reply is a
// fixed text.

/** An inbound change not yet consumed. */
interface OpenChange {
  readonly id: string;
  readonly projectId: ProjectId;
}

/** Engagement's persistence port for client changes. */
export interface ClientChangeStore {
  openChanges(): Promise<readonly OpenChange[]>;
  /** Consumes the change, posts the reply to it and records the event, in one transaction; returns the reply's id. */
  recordDeferred(change: OpenChange, reply: string, event: DomainEvent): Promise<string>;
}

interface ClientChangeOutcome {
  readonly kind: "deferred";
  readonly changeId: string;
  readonly projectId: ProjectId;
  readonly replyId: string;
}

/** What the core loop asks of the Liaison at the top of each cycle. */
export interface LiaisonClientChanges {
  runPending(): Promise<ReadonlyArray<ClientChangeOutcome | StepFaulted>>;
}

const CHANGE_NOT_APPLIED_REPLY = [
  "Your change request was received and is kept on record with this project.",
  "Ashara does not yet apply a change of direction to a project already under way, so nothing in this " +
    "project's plan has changed because of it.",
  "To have the change made, send it as a new request.",
].join("\n\n");

export class ClientChanges implements LiaisonClientChanges {
  constructor(
    private readonly store: ClientChangeStore,
    /** Each change's own fault is contained to it (containEach). */
    private readonly containment: StepContainment,
  ) {}

  /** A change whose answer cannot be recorded stays unconsumed, contained to it (containEach); only listing them throws through. */
  async runPending(): Promise<ReadonlyArray<ClientChangeOutcome | StepFaulted>> {
    const changes = await this.store.openChanges();
    return containEach(this.containment, "client-change", changes, (change) => ({ id: change.id, projectId: change.projectId }), async (change): Promise<ClientChangeOutcome> => {
      const event = createDomainEvent("client_change.not_applied", "engagement", {
        projectId: change.projectId,
        changeMessageId: change.id,
      });
      const replyId = await this.store.recordDeferred(change, CHANGE_NOT_APPLIED_REPLY, event);
      return { kind: "deferred", changeId: change.id, projectId: change.projectId, replyId };
    });
  }
}

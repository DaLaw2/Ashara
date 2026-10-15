import { createDomainEvent, type DomainEvent, type ProjectId } from "@ashara/shared";

// The client's change of direction (ADR-075 Engagement, ADR-082 d5). Applying a change to a
// project under way is not built (M3 X5). Until it is, the Liaison does not leave a change unread:
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
  readonly changeId: string;
  readonly projectId: ProjectId;
  readonly replyId: string;
}

/** What the core loop asks of the Liaison at the top of each cycle. */
export interface LiaisonClientChanges {
  runPending(): Promise<readonly ClientChangeOutcome[]>;
}

const CHANGE_NOT_APPLIED_REPLY = [
  "Your change request was received and is kept on record with this project.",
  "Ashara does not yet apply a change of direction to a project already under way, so nothing in this " +
    "project's plan has changed because of it.",
  "To have the change made, send it as a new request.",
].join("\n\n");

export class ClientChanges implements LiaisonClientChanges {
  constructor(private readonly store: ClientChangeStore) {}

  /** A store failure throws through and fails the cycle: the change stays unconsumed and is answered next cycle. */
  async runPending(): Promise<readonly ClientChangeOutcome[]> {
    const outcomes: ClientChangeOutcome[] = [];
    for (const change of await this.store.openChanges()) {
      const event = createDomainEvent("client_change.not_applied", "engagement", {
        projectId: change.projectId,
        changeMessageId: change.id,
      });
      const replyId = await this.store.recordDeferred(change, CHANGE_NOT_APPLIED_REPLY, event);
      outcomes.push({ changeId: change.id, projectId: change.projectId, replyId });
    }
    return outcomes;
  }
}

import { listUnconsumedChanges, recordClientChangeDeferred } from "@ashara/engagement";
import type { createDb } from "@ashara/db";
import type { ClientChangeStore } from "@ashara/engagement";

/** Engagement's client-change store over client_messages and domain_events. */
export function createClientChangeStore(db: ReturnType<typeof createDb>): ClientChangeStore {
  return {
    openChanges: () => listUnconsumedChanges(db),
    recordDeferred: (change, reply, event) => recordClientChangeDeferred(db, change, reply, event),
  };
}

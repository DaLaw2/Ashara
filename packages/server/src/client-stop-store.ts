import { listUnconsumedStops, recordClientStop } from "@ashara/engagement";
import type { createDb } from "@ashara/db";
import type { ClientStopStore } from "@ashara/engagement";

/** Engagement's client-stop store over client_messages, projects and work_items. */
export function createClientStopStore(db: ReturnType<typeof createDb>): ClientStopStore {
  return {
    openStops: () => listUnconsumedStops(db),
    recordStop: (stop, composeReport) => recordClientStop(db, stop, composeReport),
  };
}

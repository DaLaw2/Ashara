import { listUnconsumedStops, recordClientStop } from "@ashara/engagement";
import type { createDb } from "@ashara/db";
import { endHaltOnStop } from "@ashara/delivery";
import type { ClientStopStore } from "@ashara/engagement";

/**
 * Engagement's client-stop store over client_messages and projects; a stop that finds its project
 * halted ends the halt through Delivery's write, in the stop's transaction.
 */
export function createClientStopStore(db: ReturnType<typeof createDb>): ClientStopStore {
  return {
    openStops: () => listUnconsumedStops(db),
    recordStop: (stop) => recordClientStop(db, stop, endHaltOnStop),
  };
}

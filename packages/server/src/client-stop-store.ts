import { listDueStopReports, listUnconsumedStops, postClientStopReport, recordClientStop } from "@ashara/engagement";
import type { createDb } from "@ashara/db";
import { endHaltOnStop } from "@ashara/delivery";
import type { ClientStopStore } from "@ashara/engagement";

/**
 * Engagement's client-stop store over client_messages, projects, work_items, acceptance_sweeps and
 * guarantee_verdicts; a stop that finds its project halted ends the halt through Delivery's write, in
 * the stop's transaction.
 */
export function createClientStopStore(db: ReturnType<typeof createDb>): ClientStopStore {
  return {
    openStops: () => listUnconsumedStops(db),
    recordStop: (stop) => recordClientStop(db, stop, endHaltOnStop),
    dueStopReports: () => listDueStopReports(db),
    postStopReport: (stopId, body, verdicts) => postClientStopReport(db, stopId, body, verdicts),
  };
}

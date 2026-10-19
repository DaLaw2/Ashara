import { listDueStopReports, listUnconsumedStops, postClientStopReport, recordClientStop } from "@ashara/engagement";
import type { createDb } from "@ashara/db";
import type { ClientStopStore } from "@ashara/engagement";

/** Engagement's client-stop store over client_messages, projects, work_items, acceptance_sweeps and guarantee_verdicts. */
export function createClientStopStore(db: ReturnType<typeof createDb>): ClientStopStore {
  return {
    openStops: () => listUnconsumedStops(db),
    recordStop: (stop) => recordClientStop(db, stop),
    dueStopReports: () => listDueStopReports(db),
    postStopReport: (stopId, body, verdicts) => postClientStopReport(db, stopId, body, verdicts),
  };
}

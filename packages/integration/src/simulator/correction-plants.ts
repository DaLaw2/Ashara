import { rewriteText } from "./faults.js";
import type { QueryPlant } from "./faults.js";

/** The read of the Pending Tasks an awaited correction holds (Delivery listCorrectionHeld): at the hold and at every gate. */
const HELD_SELECTION = /JOIN correction_holds ch ON ch\.project_id = w\.project_id AND ch\.plan_revision_id IS NULL\s+WHERE w\.project_id = \$1 AND w\.level = 'Task' AND w\.status = 'Pending' AND \(EXISTS/;

/**
 * A client's correction holds the whole plan: the read of the tasks a correction holds lists every
 * Task not yet started, whatever it cites, so a task citing only keys the correction leaves as they
 * were waits on its revision (I2's correction clause).
 */
export const correctionHoldsWholePlan: QueryPlant = (args) =>
  rewriteText(args, (text) => (HELD_SELECTION.test(text) ? text.replace(/AND \(EXISTS/, "AND (TRUE OR EXISTS") : text));

/**
 * A correction holds a task only as it stood when the correction was recorded: the read of the tasks
 * it holds passes over one changed since, so a citing task that comes back to Pending after the hold
 * (a requeue, a retry, a parked exit) is dispatched on the words the correction changed (I2's
 * dispatched-held clause).
 */
export const correctionHoldMissesReturned: QueryPlant = (args) =>
  rewriteText(args, (text) => (HELD_SELECTION.test(text) ? text.replace(/AND \(EXISTS/, "AND w.updated_at < ch.created_at AND (EXISTS") : text));

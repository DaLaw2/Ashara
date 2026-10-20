import { rewriteText } from "./faults.js";
import type { QueryPlant } from "./faults.js";

const HELD_SELECTION = /FROM work_items w WHERE w\.project_id = \$1 AND w\.level = 'Task' AND w\.status = 'Pending'\s+AND \(EXISTS/;

/**
 * A client's correction holds the whole plan: the read of the tasks a correction parks (Delivery
 * holdCorrection) lists every Task not yet started, whatever it cites, so a task citing only keys the
 * correction leaves as they were waits on its revision (I2's correction clause).
 */
export const correctionHoldsWholePlan: QueryPlant = (args) =>
  rewriteText(args, (text) => (HELD_SELECTION.test(text) ? text.replace(/AND \(EXISTS/, "AND (TRUE OR EXISTS") : text));

import { stepFaultLedger } from "@ashara/db";
import type { DbHandle } from "@ashara/db";
import type { Clock, Logger, StepContainment } from "@ashara/shared";
import { projectBlockCause } from "../project-halt.js";
import { ProjectHaltRepository } from "./project-halt.js";

/**
 * The cycle's containment of its steps' subjects: their faults kept in step_faults, the errors the
 * cycle handles itself escaping, and a subject that keeps failing halting its project through
 * Delivery's guard, the one writer of a project halt, blamed on whose failure its last fault
 * was (projectBlockCause reads the fault's cause chain). Backoffs run on `clock`, the cycle's own;
 * each subject's run is scoped on `logger`.
 */
export function stepContainment(db: DbHandle, clock: Clock, escapes: (error: unknown) => boolean, logger: Logger): StepContainment {
  const halts = new ProjectHaltRepository(db);
  return {
    ...stepFaultLedger(db, clock),
    escapes,
    logger,
    halt: async (projectId, fault) => {
      const cause = projectBlockCause(fault);
      const result = await halts.block(projectId, cause);
      logger.error("delivery.step-fault-halt", `project ${projectId} ${result} (${cause.category}): ${fault.message}`, {
        projectId,
        category: cause.category,
        result,
      }, fault);
      return result;
    },
  };
}

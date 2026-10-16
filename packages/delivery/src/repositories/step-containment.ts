import { stepFaultLedger } from "@ashara/db";
import type { DbHandle } from "@ashara/db";
import type { Clock, StepContainment } from "@ashara/shared";
import { projectBlockCause } from "../project-halt.js";
import { ProjectHaltRepository } from "./project-halt.js";

/**
 * The cycle's containment of its steps' subjects: their faults kept in step_faults, the errors the
 * cycle handles itself escaping, and a subject that keeps failing halting its project through
 * Delivery's guard, the one writer of a project halt (O3 c), blamed on whose failure its last fault
 * was (projectBlockCause reads the fault's cause chain). Backoffs run on `clock`, the cycle's own.
 */
export function stepContainment(db: DbHandle, clock: Clock, escapes: (error: unknown) => boolean): StepContainment {
  const halts = new ProjectHaltRepository(db);
  return {
    ...stepFaultLedger(db, clock),
    escapes,
    halt: async (projectId, fault) => {
      const cause = projectBlockCause(fault);
      const result = await halts.block(projectId, cause);
      console.warn(`[step-faults] project ${projectId} ${result} (${cause.category}): ${fault.message}`);
      return result;
    },
  };
}

import { stepFaultLedger } from "@ashara/db";
import type { DbHandle } from "@ashara/db";
import type { StepContainment } from "@ashara/shared";
import { projectBlockCause } from "../project-halt.js";
import { ProjectHaltRepository } from "./project-halt.js";

/**
 * The cycle's containment of its steps' subjects: their faults kept in step_faults, the errors the
 * cycle handles itself escaping, and a subject that keeps failing halting its project through
 * Delivery's guard, the one writer of a project halt (O3 c).
 */
export function stepContainment(db: DbHandle, escapes: (error: unknown) => boolean): StepContainment {
  const halts = new ProjectHaltRepository(db);
  return {
    ...stepFaultLedger(db),
    escapes,
    halt: async (projectId, fault) => {
      const result = await halts.block(projectId, projectBlockCause(fault));
      console.warn(`[step-faults] project ${projectId} ${result}: ${fault.message}`);
      return result;
    },
  };
}

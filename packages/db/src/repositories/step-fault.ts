import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { StepFaultLedger, StepFaultStanding } from "@ashara/shared";
import type { DbHandle } from "../connection.js";
import { projects, stepFaults } from "../schema/index.js";
import { projectAtWork } from "./project.js";

const StandingRowSchema = z.object({ subjectId: z.string().min(1), faults: z.number().int().positive(), due: z.boolean() });

/** A step_faults row that does not read as a fault on record. */
class StepFaultRowCorrupt extends Error {
  constructor(
    readonly step: string,
    readonly issues: string,
  ) {
    super(`step_faults of step ${step}: ${issues}`);
    this.name = "StepFaultRowCorrupt";
  }
}

/** A subject was to be parked with no step_faults row on record for it: nothing was parked. */
class StepFaultNotOnRecord extends Error {
  constructor(
    readonly step: string,
    readonly subjectId: string,
  ) {
    super(`step_faults of step ${step}: parking ${subjectId} found no fault on record to park`);
    this.name = "StepFaultNotOnRecord";
  }
}

/**
 * The cycle steps' faults per subject (migration 063), kept in step_faults so a backoff, and the
 * parking of a subject that exhausted its faults, outlive a restart.
 */
export function stepFaultLedger(db: DbHandle): StepFaultLedger {
  return {
    async faultsOf(step) {
      const due = sql<unknown>`(${stepFaults.retryAt} <= now() AND (${stepFaults.parkedAt} IS NULL OR ${projectAtWork()}))`;
      const rows = await db
        .select({ subjectId: stepFaults.subjectId, faults: stepFaults.faults, due })
        .from(stepFaults)
        .innerJoin(projects, eq(projects.id, stepFaults.projectId))
        .where(eq(stepFaults.step, step));
      const standing = new Map<string, StepFaultStanding>();
      for (const row of rows) {
        const parsed = StandingRowSchema.safeParse(row);
        if (!parsed.success) throw new StepFaultRowCorrupt(step, z.prettifyError(parsed.error));
        standing.set(parsed.data.subjectId, { faults: parsed.data.faults, due: parsed.data.due });
      }
      return standing;
    },
    async record(fault) {
      const retryAt = sql`now() + make_interval(secs => ${fault.retryAfterSeconds})`;
      const [row] = await db
        .insert(stepFaults)
        .values({ step: fault.step, subjectId: fault.subjectId, projectId: fault.projectId, faults: 1, lastError: fault.error, retryAt })
        .onConflictDoUpdate({
          target: [stepFaults.step, stepFaults.subjectId],
          set: { faults: sql`${stepFaults.faults} + 1`, lastError: fault.error, retryAt, updatedAt: sql`now()` },
        })
        .returning({ faults: stepFaults.faults });
      if (row === undefined) throw new StepFaultRowCorrupt(fault.step, `recording a fault on ${fault.subjectId} returned no row`);
      return row.faults;
    },
    async clear(step, subjectId) {
      await db.delete(stepFaults).where(and(eq(stepFaults.step, step), eq(stepFaults.subjectId, subjectId)));
    },
    async park(step, subjectId) {
      const parked = await db
        .update(stepFaults)
        .set({ parkedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(stepFaults.step, step), eq(stepFaults.subjectId, subjectId)))
        .returning({ subjectId: stepFaults.subjectId });
      if (parked.length === 0) throw new StepFaultNotOnRecord(step, subjectId);
    },
  };
}

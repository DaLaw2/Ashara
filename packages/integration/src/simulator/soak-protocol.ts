import { z } from "zod";
import { CoverageSchema } from "./coverage.js";
import type { Coverage } from "./coverage.js";

/**
 * What the soak tier (scripts/simulate.ts) prints and counts of one seed: the same whether the seed
 * ran in the soak's own process or in one of its `--jobs` workers, which send it over IPC.
 */
export interface SeedReport {
  readonly seed: number;
  /** The seed's terminal lines, in order: its verdict, its violations, its replay file. */
  readonly lines: readonly string[];
  readonly coverage: Coverage;
  /** Each project the seed ended halted on Ashara's own fault (RunResult asharaHalts). */
  readonly asharaHalts: readonly string[];
  /** A failure expected-failures.ts does not list, a listed one not failed, or a run that never reported. */
  readonly unexpected: boolean;
}

const seed = z.number().int().nonnegative();

/** Parent to worker: run this seed next. */
export const SeedRequestSchema = z.strictObject({ kind: z.literal("seed"), seed });

/** Worker to parent: listening for seeds, or one seed's report. */
export const WorkerReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready") }),
  z.strictObject({
    kind: z.literal("report"),
    report: z.strictObject({
      seed,
      lines: z.array(z.string()),
      coverage: CoverageSchema,
      asharaHalts: z.array(z.string()),
      unexpected: z.boolean(),
    }),
  }),
]);

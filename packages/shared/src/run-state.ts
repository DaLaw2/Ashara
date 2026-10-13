import { z } from "zod";

/**
 * Published Language: the durable run record. `spendUsd` is the budget's cap
 * counter; it lives in process memory during a cycle and MUST survive a restart —
 * Discipline B, "a counter that lives only in process memory is not a cap".
 * Persistence (db) and the loop that enforces the cap (orchestrator) both validate
 * against this one schema; neither imports the other (ADR-044).
 *
 * There is one record per database and nothing closes it, so the spend is a
 * lifetime total (ADR-073 addendum 3, interim until story c-cost-ledger).
 */
const runStateSchema = z.object({
  runId: z.string().min(1),
  openedAt: z.string().min(1),
  spendUsd: z.number().nonnegative(),
});

export type RunState = z.infer<typeof runStateSchema>;

/** Typed failure for a run record that exists but cannot be trusted (Discipline C). */
class RunStateCorrupt extends Error {
  constructor(
    public readonly raw: string,
    public readonly detail: string,
  ) {
    super(`stored run record is not valid (${detail}); raw value: ${raw.slice(0, 200)}`);
    this.name = "RunStateCorrupt";
  }
}

/**
 * Parses a stored run record. THROWS on anything unreadable rather than
 * returning null: "no run in progress" is what resets a live budget to zero, so
 * a corrupt record must never be able to say it.
 */
export function parseRunState(raw: string): RunState {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new RunStateCorrupt(raw, e instanceof Error ? e.message : String(e));
  }

  const result = runStateSchema.safeParse(json);
  if (!result.success) {
    throw new RunStateCorrupt(
      raw,
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  }
  return result.data;
}

export function serializeRunState(state: RunState): string {
  return JSON.stringify(runStateSchema.parse(state));
}

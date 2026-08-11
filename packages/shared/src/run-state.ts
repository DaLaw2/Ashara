import { z } from "zod";

/**
 * Published Language: the durable per-run record. Every field is a cap counter
 * that lives in process memory during a cycle and MUST survive a crash-restart
 * of the run it bounds — Discipline B, "a counter that lives only in process
 * memory is not a cap". Persistence (db) and the loop that enforces the caps
 * (orchestrator) both validate against this one schema; neither imports the
 * other (ADR-044).
 *
 * `closed` is what keeps per-run semantics intact. A run that stopped on its own
 * termination verdict closes the record, so the next process starts fresh at
 * zero. A run whose process was killed leaves it OPEN, so the next process
 * adopts its spend instead of being handed the same budget a second time.
 */
export const runStateSchema = z.object({
  runId: z.string().min(1),
  openedAt: z.string().min(1),
  closed: z.boolean(),
  spendUsd: z.number().nonnegative(),
  acceptanceAttempts: z.number().int().nonnegative(),
  replanRounds: z.number().int().nonnegative(),
});

export type RunState = z.infer<typeof runStateSchema>;

/** Typed failure for a run record that exists but cannot be trusted (Discipline C). */
export class RunStateCorrupt extends Error {
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
    // eslint-disable-next-line no-restricted-syntax -- lossy-extraction-ok: migration backlog
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

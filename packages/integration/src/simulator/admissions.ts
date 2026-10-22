import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.js";
import type { QueryPlant } from "./faults.js";
import type { Violation } from "./invariants.js";

/** An admission writes its call's row (state 'pending'); the call's record completes that row. */
const LEDGER_ADMIT = 'insert into "llm_calls"';
const LEDGER_RECORD = 'update "llm_calls"';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The harness could not see when a call's row was written: the admission clause cannot be judged. */
class AdmissionsUnobservable extends Error {
  constructor(readonly detail: string) {
    super(`I5 admission clause: ${detail}`);
    this.name = "AdmissionsUnobservable";
  }
}

const sentQuery = z.object({ values: z.array(z.unknown()) }).loose();
const sentText = z.union([z.string(), z.object({ text: z.string() }).loose()]);

/** The parameters a pool query was sent with: drizzle sends (text, values) or ({ text, values }). */
function parametersOf(args: readonly unknown[]): readonly unknown[] {
  const second = args[1];
  if (Array.isArray(second)) return second;
  const first = sentQuery.safeParse(args[0]);
  return first.success ? first.data.values : [];
}

const callRows = z.array(
  z.object({
    id: z.string(),
    callSite: z.string(),
    taskId: z.string().nullable(),
    estimate: z.coerce.number().nullable(),
    cost: z.coerce.number().nullable(),
  }),
);

type Seen = { readonly kind: "admitted" | "recorded"; readonly uuids: readonly string[] };

/**
 * One admitted call as the ledger saw it: the task it was made for (null for a project's own call), the
 * deployment's recorded spend and the worst case of the calls in flight when it was admitted, and its own estimate.
 */
export interface Admission {
  readonly callSite: string;
  readonly taskId: string | null;
  readonly recordedUsd: number;
  readonly inFlightUsd: number;
  readonly inFlightCalls: number;
  readonly estimateUsd: number;
}

/**
 * I5, the admission clause, for two admissions racing the spend cap: what the spend cap's admission promises, judged
 * from outside it.
 * At every instant, the deployment's recorded spend (each row at its cost, or its estimate when
 * unmeasured, as the cap counts it) plus the worst-case estimate of every call admitted and not yet
 * recorded is within the cap. A call is admitted when its pending row's insert returns and recorded
 * when the update completing that row returns, both seen at the db seam (faults.ts) in the order
 * they returned. A call admitted and never recorded (its process died, its record failed) stays in
 * flight at its estimate for good, as its pending or unmeasured_after_crash row counts in production.
 */
export class AdmissionLedger {
  private readonly seen: Seen[] = [];
  private lastJudged: readonly Admission[] = [];

  /** Every db seam call that returned: an llm_calls insert admits a call, an llm_calls update records one. */
  written(label: string, args: readonly unknown[]): void {
    const kind = label.startsWith(LEDGER_ADMIT) ? "admitted" : label.startsWith(LEDGER_RECORD) ? "recorded" : null;
    if (kind === null) return;
    const uuids = parametersOf(args).filter((value): value is string => typeof value === "string" && UUID.test(value));
    this.seen.push({ kind, uuids });
  }

  /** Every admission the last judgment replayed, in the order its row's insert returned. */
  get judged(): readonly Admission[] {
    return this.lastJudged;
  }

  /** The first admission past the cap, or null; throws when a row's admission or record was not seen whole. */
  async judge(observer: Database, capUsd: number, step: number): Promise<Violation | null> {
    const { admissions, unseen } = await this.replay(observer);
    this.lastJudged = admissions;
    const past = overCommitted(admissions, capUsd, step);
    if (past === null && unseen !== null) throw unseen;
    return past;
  }

  private async replay(
    observer: Database,
  ): Promise<{ readonly admissions: readonly Admission[]; readonly unseen: AdmissionsUnobservable | null }> {
    const rows = callRows.parse(
      (
        await observer.execute(sql`
          SELECT id, call_site AS "callSite", task_id AS "taskId", estimated_cost_usd AS estimate, cost_usd AS cost
          FROM llm_calls`)
      ).rows,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const admitted = new Set<string>();
    const recorded = new Set<string>();
    const admissions: Admission[] = [];
    let spent = 0;
    let inFlight = 0;
    for (const event of this.seen) {
      const ids = event.uuids.filter((uuid) => byId.has(uuid));
      const [id] = ids;
      if (id === undefined || ids.length > 1) {
        throw new AdmissionsUnobservable(
          `an llm_calls ${event.kind === "admitted" ? "insert" : "update"} named ${ids.length} llm_calls rows, not one`,
        );
      }
      const row = byId.get(id);
      if (row === undefined) throw new AdmissionsUnobservable(`the llm_calls row ${id} vanished while it was judged`);
      if (row.estimate === null)
        throw new AdmissionsUnobservable(`the llm_calls row ${id} (${row.callSite}) carries no estimate`);
      if (event.kind === "recorded") {
        if (!admitted.has(id) || recorded.has(id))
          throw new AdmissionsUnobservable(
            `the llm_calls row ${id} (${row.callSite}) was recorded ` +
              `${recorded.has(id) ? "twice" : "before it was admitted"}`,
          );
        recorded.add(id);
        inFlight -= row.estimate;
        spent += row.cost ?? row.estimate;
        continue;
      }
      if (admitted.has(id))
        throw new AdmissionsUnobservable(`the llm_calls row ${id} (${row.callSite}) was admitted twice`);
      admissions.push({
        callSite: row.callSite,
        taskId: row.taskId,
        recordedUsd: spent,
        inFlightUsd: inFlight,
        inFlightCalls: admitted.size - recorded.size,
        estimateUsd: row.estimate,
      });
      admitted.add(id);
      inFlight += row.estimate;
    }
    const missed = rows.find((row) => !admitted.has(row.id));
    const unseen =
      missed === undefined
        ? null
        : new AdmissionsUnobservable(
            `the llm_calls row ${missed.id} (${missed.callSite}) was written where the db seam did not see it`,
          );
    return { admissions, unseen };
  }
}

/** The first of `admissions` that took the deployment past `capUsd`, as I5's admission clause names it, or null. */
function overCommitted(admissions: readonly Admission[], capUsd: number, step: number): Violation | null {
  const past = admissions.find((each) => each.recordedUsd + each.inFlightUsd + each.estimateUsd > capUsd + 1e-9);
  if (past === undefined) return null;
  return {
    invariant: "I5",
    step,
    statement:
      `the spend cap admitted past itself: when ${past.callSite} was admitted, recorded spend ` +
      `$${past.recordedUsd.toFixed(6)} plus ` +
      (`${past.inFlightCalls + 1} call(s) in flight at their worst case ` +
        `$${(past.inFlightUsd + past.estimateUsd).toFixed(6)} exceeds the cap $${capUsd}`),
    key: "I5:over-committed",
  };
}

/** The spend read's in-flight sum, as Finance's LlmCallRepository.spend sends it. */
const IN_FLIGHT_FILTER = "FILTER (WHERE state = 'pending')";

/**
 * The admission clause's mutation check: the spend cap's read leaves the pending rows out, so an
 * admission counts the recorded spend alone and every call admitted and not yet recorded is
 * invisible to it, the way an in-memory in-flight set is invisible to the next process.
 */
export const pendingUncounted: QueryPlant = (args) => {
  const parsed = sentText.safeParse(args[0]);
  if (!parsed.success) return null;
  const text = typeof parsed.data === "string" ? parsed.data : parsed.data.text;
  if (!text.includes(IN_FLIGHT_FILTER)) return null;
  const planted = text.replace(IN_FLIGHT_FILTER, "FILTER (WHERE false)");
  return [typeof parsed.data === "string" ? planted : { ...parsed.data, text: planted }, ...args.slice(1)];
};

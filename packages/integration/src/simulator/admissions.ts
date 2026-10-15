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
    estimate: z.coerce.number().nullable(),
    cost: z.coerce.number().nullable(),
  }),
);

type Seen = { readonly kind: "admitted" | "recorded"; readonly uuids: readonly string[] };

/**
 * I5, the admission clause (F11): what the spend cap's admission promises, judged from outside it.
 * At every instant, the deployment's recorded spend (each row at its cost, or its estimate when
 * unmeasured, as the cap counts it) plus the worst-case estimate of every call admitted and not yet
 * recorded is within the cap. A call is admitted when its pending row's insert returns and recorded
 * when the update completing that row returns, both seen at the db seam (faults.ts) in the order
 * they returned. A call admitted and never recorded (its process died, its record failed) stays in
 * flight at its estimate for good, as its pending or unmeasured_after_crash row counts in production.
 */
export class AdmissionLedger {
  private readonly seen: Seen[] = [];

  /** Every db seam call that returned: an llm_calls insert admits a call, an llm_calls update records one. */
  written(label: string, args: readonly unknown[]): void {
    const kind = label.startsWith(LEDGER_ADMIT) ? "admitted" : label.startsWith(LEDGER_RECORD) ? "recorded" : null;
    if (kind === null) return;
    const uuids = parametersOf(args).filter((value): value is string => typeof value === "string" && UUID.test(value));
    this.seen.push({ kind, uuids });
  }

  /** The first admission past the cap, or null; throws when a row's admission or record was not seen whole. */
  async judge(observer: Database, capUsd: number, step: number): Promise<Violation | null> {
    const rows = callRows.parse(
      (
        await observer.execute(sql`
          SELECT id, call_site AS "callSite", estimated_cost_usd AS estimate, cost_usd AS cost FROM llm_calls`)
      ).rows,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const admitted = new Set<string>();
    const recorded = new Set<string>();
    let spent = 0;
    let inFlight = 0;
    for (const event of this.seen) {
      const ids = event.uuids.filter((uuid) => byId.has(uuid));
      const [id] = ids;
      if (id === undefined || ids.length > 1) {
        throw new AdmissionsUnobservable(`an llm_calls ${event.kind === "admitted" ? "insert" : "update"} named ${ids.length} llm_calls rows, not one`);
      }
      const row = byId.get(id);
      if (row === undefined) throw new AdmissionsUnobservable(`the llm_calls row ${id} vanished while it was judged`);
      if (row.estimate === null) throw new AdmissionsUnobservable(`the llm_calls row ${id} (${row.callSite}) carries no estimate`);
      if (event.kind === "recorded") {
        if (!admitted.has(id) || recorded.has(id)) throw new AdmissionsUnobservable(`the llm_calls row ${id} (${row.callSite}) was recorded ${recorded.has(id) ? "twice" : "before it was admitted"}`);
        recorded.add(id);
        inFlight -= row.estimate;
        spent += row.cost ?? row.estimate;
        continue;
      }
      if (admitted.has(id)) throw new AdmissionsUnobservable(`the llm_calls row ${id} (${row.callSite}) was admitted twice`);
      admitted.add(id);
      inFlight += row.estimate;
      if (spent + inFlight > capUsd + 1e-9) {
        return {
          invariant: "I5",
          step,
          statement:
            `the spend cap admitted past itself: when ${row.callSite} was admitted, recorded spend $${spent.toFixed(6)} plus ` +
            `${admitted.size - recorded.size} call(s) in flight at their worst case $${inFlight.toFixed(6)} exceeds the cap $${capUsd}`,
          key: "I5:over-committed",
        };
      }
    }
    const unseen = rows.find((row) => !admitted.has(row.id));
    if (unseen !== undefined) throw new AdmissionsUnobservable(`the llm_calls row ${unseen.id} (${unseen.callSite}) was written where the db seam did not see it`);
    return null;
  }
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
  if (!parsed.success) return [...args];
  const text = typeof parsed.data === "string" ? parsed.data : parsed.data.text;
  if (!text.includes(IN_FLIGHT_FILTER)) return [...args];
  const planted = text.replace(IN_FLIGHT_FILTER, "FILTER (WHERE false)");
  return [typeof parsed.data === "string" ? planted : { ...parsed.data, text: planted }, ...args.slice(1)];
};

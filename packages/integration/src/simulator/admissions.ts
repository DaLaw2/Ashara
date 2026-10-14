import { sql } from "drizzle-orm";
import { z } from "zod";
import { SpendCap } from "@ashara/finance";
import type { Database } from "./database.js";
import type { Violation } from "./invariants.js";

/** How drizzle sends a timestamp parameter (Date.prototype.toISOString). */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LEDGER_INSERT = 'insert into "llm_calls"';

/** The harness could not see when a call's row was written: the admission clause cannot be judged. */
class AdmissionsUnobservable extends Error {
  constructor(readonly detail: string) {
    super(`I5 admission clause: ${detail}`);
    this.name = "AdmissionsUnobservable";
  }
}

const sentQuery = z.object({ values: z.array(z.unknown()) }).loose();

/** The parameters a pool query was sent with: drizzle sends (text, values) or ({ text, values }). */
function parametersOf(args: readonly unknown[]): readonly unknown[] {
  const second = args[1];
  if (Array.isArray(second)) return second;
  const first = sentQuery.safeParse(args[0]);
  return first.success ? first.data.values : [];
}

const callRows = z.array(
  z.object({
    requestedAt: z.coerce.date(),
    callSite: z.string(),
    estimate: z.coerce.number().nullable(),
    cost: z.coerce.number().nullable(),
  }),
);

/**
 * I5, the admission clause (F11): what the spend cap's admission promises, judged from outside it.
 * At every instant, the deployment's recorded spend (each row at its cost, or its estimate when
 * unmeasured, as the cap counts it) plus the worst-case estimate of every call admitted and not yet
 * recorded is within the cap. A call is admitted at its row's `created_at` (the gateway reads the
 * clock right after the admission, and the simulated clock never repeats an instant) and recorded
 * when its insert returns, at the clock's last instant then (seen at the db seam, faults.ts).
 *
 * Judged as strictly as the harness can see, never more: a call admitted and never recorded (its
 * process died, its write failed) has no row and counts nothing, though production holds its
 * estimate in flight until the restart. And a call counts at its cost from the moment its insert
 * returns, while production still holds its larger estimate until it is released just after.
 */
export class AdmissionLedger {
  private readonly recordedAt = new Map<number, number>();
  private readonly unreadable: string[] = [];

  constructor(private readonly clock: { peek(): number }) {}

  /** Every db seam call that returned: an llm_calls insert records its call now. */
  written(label: string, args: readonly unknown[]): void {
    if (!label.startsWith(LEDGER_INSERT)) return;
    const instants = parametersOf(args).filter((value): value is string => typeof value === "string" && ISO_INSTANT.test(value));
    const [instant] = instants;
    if (instant === undefined || instants.length > 1) {
      this.unreadable.push(`an llm_calls insert carried ${instants.length} timestamp parameters, not one`);
      return;
    }
    const requestedAt = Date.parse(instant);
    if (this.recordedAt.has(requestedAt)) this.unreadable.push(`two llm_calls inserts carried the instant ${instant}`);
    this.recordedAt.set(requestedAt, this.clock.peek());
  }

  /** The first admission past the cap, or null; throws when a row's write was not seen. */
  async judge(observer: Database, capUsd: number, step: number): Promise<Violation | null> {
    if (this.unreadable.length > 0) throw new AdmissionsUnobservable(this.unreadable.join("; "));
    const rows = callRows.parse(
      (
        await observer.execute(sql`
          SELECT created_at AS "requestedAt", call_site AS "callSite", estimated_cost_usd AS estimate, cost_usd AS cost
          FROM llm_calls ORDER BY created_at`)
      ).rows,
    );
    type Event = { readonly at: number; readonly kind: "admitted" | "recorded"; readonly row: (typeof rows)[number]; readonly estimate: number };
    const events: Event[] = [];
    for (const row of rows) {
      const at = row.requestedAt.getTime();
      const recorded = this.recordedAt.get(at);
      if (recorded === undefined) throw new AdmissionsUnobservable(`the llm_calls row of ${row.requestedAt.toISOString()} (${row.callSite}) was written where the db seam did not see it`);
      if (row.estimate === null) throw new AdmissionsUnobservable(`the llm_calls row of ${row.requestedAt.toISOString()} (${row.callSite}) carries no estimate`);
      events.push({ at, kind: "admitted", row, estimate: row.estimate }, { at: recorded, kind: "recorded", row, estimate: row.estimate });
    }
    // At one instant the admission comes first: the insert's instant is the last one read before it.
    events.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "admitted" ? -1 : 1));
    let spent = 0;
    let inFlight = 0;
    let calls = 0;
    for (const event of events) {
      if (event.kind === "recorded") {
        inFlight -= event.estimate;
        calls -= 1;
        spent += event.row.cost ?? event.estimate;
        continue;
      }
      inFlight += event.estimate;
      calls += 1;
      if (spent + inFlight > capUsd + 1e-9) {
        return {
          invariant: "I5",
          step,
          statement:
            `the spend cap admitted past itself: when ${event.row.callSite} was admitted at ${event.row.requestedAt.toISOString()}, ` +
            `recorded spend $${spent.toFixed(6)} plus ${calls} call(s) in flight at their worst case $${inFlight.toFixed(6)} exceeds the cap $${capUsd}`,
          key: "I5:over-committed",
        };
      }
    }
    return null;
  }
}

/**
 * The pre-B9 read order planted in Finance's spend cap (the admission clause's mutation check):
 * an admission reads the recorded spend first and the in-flight estimates after it, so a call whose
 * row is committed after the read's snapshot and released before the in-flight sum counts in
 * neither. Patches the class for the whole process; returns what puts the real order back.
 */
export function plantLedgerReadFirst(): () => void {
  const prototype = SpendCap.prototype;
  const real = prototype["admissionView"];
  prototype["admissionView"] = async function (this: SpendCap, scope) {
    const spentUsd = await this["deps"].ledger.spentUsd(scope);
    const inFlightUsd = this["inFlightUsd"](scope.kind === "project" ? scope.projectId : undefined);
    return { spentUsd, inFlightUsd };
  };
  return () => {
    prototype["admissionView"] = real;
  };
}

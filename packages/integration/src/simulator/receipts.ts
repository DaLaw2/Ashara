import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.js";
import { rewriteText } from "./faults.js";
import type { QueryPlant } from "./faults.js";
import type { Violation } from "./invariants.js";

/**
 * I4's receipt clause: every message the client sends is answered, whatever its project's state.
 * Each inbound message on record before a cycle began has its receipt (an outbound report naming it
 * in receipt_of) once that cycle ends, unless the cycle carried an injected fault, a restart or a
 * duplicated wake, or the receipt's own subject is waiting out the backoff of a fault on record
 * (step_faults): the receipt step runs at the top of every cycle, full or halted, and lists every
 * message owed one. Judged by structure: which rows are owed and which name them, never the wording.
 */

const unansweredRow = z.object({ id: z.string(), projectId: z.string(), kind: z.string(), backingOff: z.boolean() });
type Unanswered = z.infer<typeof unansweredRow>;

/** The inbound messages of the run's projects with no receipt yet, each with whether its receipt's subject has a fault on record. */
export async function unansweredMessages(db: Database, projectIds: readonly string[]): Promise<Unanswered[]> {
  if (projectIds.length === 0) return [];
  const ids = sql.join(
    projectIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result = await db.execute(sql`
    SELECT m.id, m.project_id AS "projectId", m.kind,
           EXISTS (SELECT 1 FROM step_faults f WHERE f.step = 'client-receipt' AND f.subject_id = 'receipt:' || m.id::text) AS "backingOff"
    FROM client_messages m
    WHERE m.project_id IN (${ids}) AND m.direction = 'inbound' AND NOT m.receipt_waived
      AND NOT EXISTS (SELECT 1 FROM client_messages r WHERE r.direction = 'outbound' AND r.receipt_of = m.id)
    ORDER BY m.created_at, m.id`);
  return z.array(unansweredRow).parse(result.rows);
}

/**
 * The messages owed a receipt before a clean cycle that still have none after it, each keyed by its
 * kind, with the index of its project among the run's.
 */
export function lateReceipts(
  owed: ReadonlySet<string>,
  after: readonly Unanswered[],
  projectIds: readonly string[],
  step: number,
): Array<{ readonly project: number; readonly violation: Violation }> {
  return after
    .filter((message) => owed.has(message.id) && !message.backingOff)
    .map((message) => ({
      project: projectIds.indexOf(message.projectId),
      violation: {
        invariant: "I4",
        step,
        statement: `an inbound ${message.kind} on record before the cycle began still has no receipt after it, with no fault on its receipt`,
        key: `I4:receipt-late:${message.kind}`,
      },
    }));
}

/** The listing of the messages owed a receipt (Engagement listDueReceipts) lists none, so no message is ever answered (I4's receipt clause). */
export const receiptSkipped: QueryPlant = (args) =>
  rewriteText(args, (text) => text.replace(/NOT EXISTS \(SELECT 1 FROM client_messages rc WHERE rc\.receipt_of/, "FALSE AND NOT EXISTS (SELECT 1 FROM client_messages rc WHERE rc.receipt_of"));

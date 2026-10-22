import { sql } from "drizzle-orm";
import { z } from "zod";
import { correctionPair } from "./correction-draws.js";
import type { CorrectionDraw, CorrectionKind } from "./correction-draws.js";
import type { Coverage } from "./coverage.js";
import type { Database } from "./database.js";

/** vision_revisions.ops as the simulator reads them back: what each stored operation acts on and how. */
const storedOpsSchema = z.array(z.object({ target: z.string(), action: z.string() })).min(1);

/** The correction kind each stored operation is, by `<target>:<action>`: the kinds the scripted Liaison reads. */
const KIND_OF_STORED_OP: ReadonlyMap<string, CorrectionKind> = new Map([
  ["guarantee:amend", "rewrite-guarantee"],
  ["guarantee:add", "add-guarantee"],
  ["guarantee:withdraw", "withdraw-guarantee"],
  ["assumption:amend", "change-assumption"],
  ["exclusion:add", "add-exclusion"],
  ["interface:amend", "change-interface"],
]);

/** A revision stored for the client's correction holds an operation no correction kind is. */
class UnknownCorrectionOp extends Error {
  constructor(
    readonly draw: CorrectionDraw,
    readonly op: string,
  ) {
    super(
      `the revision stored for the correction drawn as ${correctionPair(draw)} holds the operation ${op}, ` +
        `which is no correction kind the scripted Liaison reads`,
    );
    this.name = "UnknownCorrectionOp";
  }
}

/**
 * The coverage pairs one stored revision of the client's correction records: the drawn arrival, which
 * the run waited for before it posted, with the kind of each operation the system stored, never the
 * kind drawn.
 * @testseam correction-coverage.test.ts feeds it a drawn kind and a stored one that differ; sampleCorrection is its
 * production caller
 */
export function storedCorrectionPairs(draw: CorrectionDraw, ops: unknown): string[] {
  return storedOpsSchema.parse(ops).map(({ target, action }) => {
    const kind = KIND_OF_STORED_OP.get(`${target}:${action}`);
    if (kind === undefined) throw new UnknownCorrectionOp(draw, `${target}:${action}`);
    return correctionPair({ arrival: draw.arrival, kind });
  });
}

const revisionRows = z.array(z.object({ ops: z.unknown(), status: z.string() }));

/**
 * The client's correction as the system stored it, read once at the run's end: each vision revision
 * read from the inbound change sent with `body` adds its pairs (storedCorrectionPairs) to the coverage.
 * Returns the trace line naming what was stored.
 */
export async function sampleCorrection(
  coverage: Coverage,
  observer: Database,
  projectId: string,
  draw: CorrectionDraw,
  body: string,
): Promise<string> {
  const rows = await observer.execute(sql`
    SELECT r.ops, r.status FROM vision_revisions r JOIN client_messages m ON m.id = r.source_message_id
    WHERE r.project_id = ${projectId} AND m.direction = 'inbound' AND m.kind = 'change' AND m.body = ${body}
    ORDER BY r.created_at, r.id`);
  const stored = revisionRows.parse(rows.rows).map((row) => {
    const pairs = storedCorrectionPairs(draw, row.ops);
    for (const pair of pairs) coverage.corrections.add(pair);
    return `${pairs.join(", ")} (${row.status})`;
  });
  const asked = `client correction drawn as ${correctionPair(draw)}`;
  return stored.length === 0 ? `${asked}: no revision of it stored` : `${asked}: stored as ${stored.join("; ")}`;
}

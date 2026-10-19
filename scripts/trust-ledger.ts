/**
 * The trust ledger: one append-only JSONL file the operator keeps outside this repository, read here and never written
 * by any package. Three row kinds share one discriminated union. A `prereg` row fixes what a stage is judged by before
 * any of its runs; a `mapping` row records one blind reader's mapping of a run's report onto the intended guarantees,
 * by the digest of the reader's file; a `pair` row is one run x intended guarantee, the unit every trust metric counts.
 *
 * The file is read whole and refused at its first fault, so no number is ever computed from part of a ledger:
 * - a row that is not JSON or fails its schema, named by its `seq` (or its line, when it has no readable `seq`);
 * - a `seq` that is not the previous one plus one, so a deleted or reordered row is seen;
 * - a `pair` row whose run and arm lack two earlier `mapping` rows, reader A and reader B, at least one of them read
 *   outside the development loop: the mappings are on the ledger before any hidden verdict of the run is joined;
 * - a `pair` row of a stage with no earlier `prereg` row, of another commit than the stage's, of a tender the stage
 *   did not register, disagreeing with an earlier row of its run on the run's facts, or repeating a run, arm and
 *   intended guarantee already recorded.
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { describeErrorChain, JsonParseFailed, parseJson } from "@ashara/shared";

class TrustLedgerInvalid extends Error {
  constructor(
    readonly path: string,
    readonly at: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`trust ledger ${JSON.stringify(path)}: ${at}: ${detail}`, options);
    this.name = "TrustLedgerInvalid";
  }
}

const idSchema = z.string().regex(/^[A-Za-z0-9._-]+$/, "an id is letters, digits, '.', '_' or '-'");
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "a digest is sha256: and 64 lowercase hex digits");
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/, "a commit is a full 40-digit lowercase hex sha");
const createdAtSchema = z.iso.datetime({ offset: true });
export const armSchema = z.enum(["ashara", "baseline", "qa3"]);
export type Arm = z.infer<typeof armSchema>;

const preregSchema = z.strictObject({
  kind: z.literal("prereg"),
  seq: z.number().int().positive(),
  stage: idSchema,
  preregDigest: digestSchema,
  commit: commitSchema,
  modelsDigest: digestSchema,
  suiteDigests: z.record(idSchema, digestSchema).refine((record) => Object.keys(record).length > 0, "the stage registers no tender"),
  intendedDigests: z.record(idSchema, digestSchema),
  analysisDigest: digestSchema,
  /** Tenders the stage reports in the regression column from its start, because they already fed a fix. */
  regressionTenders: z.array(idSchema),
  /** The bars the owner set for the stage, as written; null until they are set. */
  bars: z.array(z.string().trim().min(1)).min(1).nullable(),
  createdAt: createdAtSchema,
}).refine(
  (row) => Object.keys(row.suiteDigests).every((tender) => row.intendedDigests[tender] !== undefined) &&
    Object.keys(row.intendedDigests).every((tender) => row.suiteDigests[tender] !== undefined),
  { message: "every registered tender has both a suite digest and an intended-list digest", path: ["intendedDigests"] },
);
export type PreregRow = z.infer<typeof preregSchema>;

const mappingSchema = z.strictObject({
  kind: z.literal("mapping"),
  seq: z.number().int().positive(),
  run: idSchema,
  arm: armSchema,
  reader: z.enum(["A", "B"]),
  readerRole: z.enum(["in-house", "outside"]),
  fileDigest: digestSchema,
  createdAt: createdAtSchema,
});
type MappingRow = z.infer<typeof mappingSchema>;

/** Where a client could see the guarantee hold or break; the same four kinds the contract records. */
const observationSchema = z.enum(["output", "errors", "exit-status", "stored-data"]);
const basisSchema = z.enum(["client-stated", "assumed-unconfirmed", "derived"]);

const pairSchema = z.strictObject({
  kind: z.literal("pair"),
  seq: z.number().int().positive(),
  stage: idSchema,
  run: idSchema,
  arm: armSchema,
  tender: idSchema,
  stack: z.string().trim().min(1),
  tenderKind: z.string().trim().min(1),
  seed: z.string().regex(/^[0-9a-f]{64}$/, "a seed is a sha256 hex digest"),
  commit: commitSchema,
  intended: idSchema,
  intendedSource: z.enum(["in-house", "outside-authored"]),
  custody: z.enum(["in-house hidden", "separate uid"]),
  /**
   * The two readers' mapping of the intended guarantee onto the arm's report, a dispute already settled against the
   * arm: unmapped or narrowed when either reader read it so, `agreed` false.
   */
  mapped: z.strictObject({ to: idSchema.nullable(), narrowed: z.boolean(), agreed: z.boolean() }),
  /**
   * What the arm reported for the item mapped to the intended guarantee. With `mapped.to` null, a `pass` here is a
   * delivery the arm claimed on an item of its own that covers no intended guarantee: an omission dressed as delivery.
   */
  reported: z
    .strictObject({
      verdict: z.enum(["pass", "fail", "unjudged", "not-reported"]),
      evidence: z.string().trim().min(1).nullable(),
      basis: basisSchema.nullable(),
    })
    .refine((claim) => (claim.verdict === "not-reported" ? claim.evidence === null : claim.verdict !== "pass" || claim.evidence !== null), {
      message: "a pass names its evidence class and a not-reported verdict names none",
      path: ["evidence"],
    }),
  hidden: z
    .strictObject({
      verdict: z.enum(["pass", "fail", "unjudged"]),
      adequacyGated: z.boolean(),
      /** The operator's triage found the suite, not the product, at fault for this verdict. */
      suiteDefect: z.boolean(),
      reason: z.string().trim().min(1).nullable(),
    })
    .refine((hidden) => hidden.verdict !== "unjudged" || hidden.reason !== null, { message: "an unjudged hidden verdict carries its reason", path: ["reason"] }),
  observation: observationSchema,
  firstDraft: z.strictObject({ covered: z.boolean(), narrowed: z.boolean() }).nullable(),
  spend: z.strictObject({ claudeUsd: z.number().nonnegative(), deepseekUsd: z.number().nonnegative() }),
  runOutcome: z.enum(["terminal", "sprint0-failed", "no-report"]),
  createdAt: createdAtSchema,
});
export type PairRow = z.infer<typeof pairSchema>;

const rowSchema = z.discriminatedUnion("kind", [preregSchema, mappingSchema, pairSchema]);
type LedgerRow = z.infer<typeof rowSchema>;

const seqOnlySchema = z.looseObject({ seq: z.number().int() });
const anyJsonSchema = z.unknown();

export interface Ledger {
  readonly prereg: readonly PreregRow[];
  readonly mappings: readonly MappingRow[];
  readonly pairs: readonly PairRow[];
}

/** The facts every pair row of one run repeats; two rows of a run that differ on one are refused. */
const RUN_FACTS = ["stage", "tender", "stack", "tenderKind", "seed", "commit", "runOutcome", "custody"] as const;

function parseRow(path: string, line: string, lineNumber: number): LedgerRow {
  let raw: unknown;
  try {
    raw = parseJson(anyJsonSchema, line, `line ${lineNumber}`);
  } catch (err) {
    if (!(err instanceof JsonParseFailed)) throw err;
    throw new TrustLedgerInvalid(path, `line ${lineNumber}`, describeErrorChain(err), { cause: err });
  }
  const seq = seqOnlySchema.safeParse(raw);
  const at = seq.success ? `seq ${seq.data.seq} (line ${lineNumber})` : `line ${lineNumber} (no readable seq)`;
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`);
    throw new TrustLedgerInvalid(path, at, issues.join("; "));
  }
  return parsed.data;
}

/** Checks the order and integrity rules of the whole ledger; the rows are already schema-valid. */
function checkLedger(path: string, rows: readonly LedgerRow[]): Ledger {
  const prereg: PreregRow[] = [];
  const mappings: MappingRow[] = [];
  const pairs: PairRow[] = [];
  const runFacts = new Map<string, PairRow>();
  const seen = new Set<string>();
  let previous = 0;
  for (const row of rows) {
    const at = `seq ${row.seq}`;
    if (row.seq !== previous + 1) throw new TrustLedgerInvalid(path, at, `seq follows ${previous}: a row is missing, repeated or out of order`);
    previous = row.seq;
    if (row.kind === "prereg") {
      if (prereg.some((earlier) => earlier.stage === row.stage)) throw new TrustLedgerInvalid(path, at, `stage ${row.stage} is pre-registered twice`);
      prereg.push(row);
      continue;
    }
    if (row.kind === "mapping") {
      if (mappings.some((earlier) => earlier.run === row.run && earlier.arm === row.arm && earlier.reader === row.reader)) {
        throw new TrustLedgerInvalid(path, at, `reader ${row.reader} of run ${row.run} arm ${row.arm} is recorded twice`);
      }
      mappings.push(row);
      continue;
    }
    const stage = prereg.find((earlier) => earlier.stage === row.stage);
    if (stage === undefined) throw new TrustLedgerInvalid(path, at, `stage ${row.stage} has no earlier prereg row`);
    if (row.commit !== stage.commit) throw new TrustLedgerInvalid(path, at, `commit ${row.commit} is not stage ${row.stage}'s commit ${stage.commit}`);
    if (stage.suiteDigests[row.tender] === undefined) throw new TrustLedgerInvalid(path, at, `tender ${row.tender} is not registered for stage ${row.stage}`);
    const readers = mappings.filter((earlier) => earlier.run === row.run && earlier.arm === row.arm);
    const hasBoth = readers.some((reader) => reader.reader === "A") && readers.some((reader) => reader.reader === "B");
    if (!hasBoth || !readers.some((reader) => reader.readerRole === "outside")) {
      throw new TrustLedgerInvalid(path, at, `run ${row.run} arm ${row.arm} lacks two earlier mapping rows (readers A and B, one outside): the mapping must precede the hidden verdict`);
    }
    const key = `${row.run}\0${row.arm}\0${row.intended}`;
    if (seen.has(key)) throw new TrustLedgerInvalid(path, at, `run ${row.run} arm ${row.arm} records intended guarantee ${row.intended} twice`);
    seen.add(key);
    const runKey = `${row.run}\0${row.arm}`;
    const first = runFacts.get(runKey);
    if (first === undefined) {
      runFacts.set(runKey, row);
    } else {
      const differs = RUN_FACTS.find((fact) => first[fact] !== row[fact]);
      if (differs !== undefined) throw new TrustLedgerInvalid(path, at, `${differs} differs from seq ${first.seq} of the same run`);
    }
    pairs.push(row);
  }
  return { prereg, mappings, pairs };
}

/** The parsed and checked ledger at `path`; any fault throws TrustLedgerInvalid naming its row. */
export async function readTrustLedger(path: string): Promise<Ledger> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new TrustLedgerInvalid(path, "(file)", `cannot be read: ${describeErrorChain(err)}`, { cause: err });
  }
  if (text === "") throw new TrustLedgerInvalid(path, "(file)", "the ledger is empty: no stage is pre-registered");
  if (!text.endsWith("\n")) throw new TrustLedgerInvalid(path, "(file)", "the last line is unterminated (a partly written row)");
  const rows = text
    .slice(0, -1)
    .split("\n")
    .map((line, index) => parseRow(path, line, index + 1));
  return checkLedger(path, rows);
}

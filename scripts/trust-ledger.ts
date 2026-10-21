/**
 * The trust ledger: one append-only JSONL file the operator keeps outside this repository, read and appended here and
 * never read or written by any package. Three row kinds share one discriminated union. A `prereg` row fixes what a stage is judged by before
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
 *
 * Appending the Ashara arm of one run:
 *
 *   npx tsx scripts/trust-ledger.ts append <project-id> --run <label> --facts <facts.json> --mapping-a <reader-a.toml>
 *     --mapping-b <reader-b.toml> --key <key.json> [--hidden <verdict.json>] [--pool <dir>] [--ledger <ledger.jsonl>]
 *
 * The ledger is --ledger, else ASHARA_TRUST_LEDGER. It is refused under the operator's hidden directory in the home
 * directory with LedgerPathRefused,
 * judged by the path alone before anything there is touched, and inside any git work tree. The pick is the run's
 * record in the pool's pick ledger (--pool, else ASHARA_TENDER_POOL). Reader A is the in-house mapping reader and
 * reader B the one outside the development loop; both mapped the same packet, whose key is --key. The facts file is
 * the operator's record of what no other input holds: the stage, the tender's stack and kind, who authored the
 * intended list, the custody tier, the run's outcome, and per intended guarantee where a client observes it, whether
 * its hidden verdict is adequacy-gated or a suite defect, and the first draft's coverage of it.
 *
 * The two mapping rows go first. A reader already on the ledger for the run is not appended again, and a mapping file
 * whose digest is not the one its ledger row records is refused with MappingDigestMismatch, so a mapping is never
 * changed after it is recorded. Without --hidden only the mapping rows are appended: the order the blind mapping
 * requires, mappings recorded before any hidden verdict is opened. With --hidden one pair row per intended guarantee
 * follows, Ashara's side from the guarantee_verdicts of the run's last terminal report and the spend from its llm_calls,
 * an unmeasured call at its worst-case estimate; a provider with unmeasured calls and no estimate is refused, never
 * recorded as $0. A run whose pair rows are already on the ledger appends nothing. Every new row is checked with the whole ledger
 * before the file is touched, so a refused append writes nothing.
 *
 * Exit status: 0 appended or nothing to append; 1 a usage error, an unreadable or inconsistent input, or a ledger
 * that would not read; 2 a ledger path under the hidden directory or inside a git work tree, or whose tree cannot be
 * determined.
 */

import { appendFile, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createDb, DEFAULT_DATABASE_URL, type DbHandle } from "@ashara/db";
import { lastReportGuaranteeVerdictsOf } from "@ashara/engagement";
import { describeErrorChain, JsonParseFailed, parseJson, parseProjectId, type ProjectId } from "@ashara/shared";
import { projectHalted } from "@ashara/delivery/predicates";
import { projectWorkItems } from "@ashara/delivery/reads";
import { readRunEvidence } from "@ashara/workplace";
import type { JudgedVerdict } from "./hidden-verdict.js";
import { armSchema, type MappingFile, PoolMappingRefused, refuseInsideGitTree } from "./pool-mapping.js";
import { poolDirOf, recordedPick, type PickRecord } from "./pool-selection.js";
import { readHidden, readMapping, type ReadMapping } from "./run-report-inputs.js";
import { type AsharaGuarantees, asharaClaim, asharaGuaranteesOf, type StoredGuaranteeVerdict } from "./run-report-format.js";

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

async function readLedgerText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new TrustLedgerInvalid(path, "(file)", `cannot be read: ${describeErrorChain(err)}`, { cause: err });
  }
}

/** The ledger `text` read from `path`, parsed and checked; any fault throws TrustLedgerInvalid naming its row. */
function parseLedger(path: string, text: string): Ledger {
  if (text === "") throw new TrustLedgerInvalid(path, "(file)", "the ledger is empty: no stage is pre-registered");
  if (!text.endsWith("\n")) throw new TrustLedgerInvalid(path, "(file)", "the last line is unterminated (a partly written row)");
  const rows = text
    .slice(0, -1)
    .split("\n")
    .map((line, index) => parseRow(path, line, index + 1));
  return checkLedger(path, rows);
}

/** The parsed and checked ledger at `path`; any fault throws TrustLedgerInvalid naming its row. */
export async function readTrustLedger(path: string): Promise<Ledger> {
  return parseLedger(path, await readLedgerText(path));
}

const COMMAND = "trust-ledger append";
const USAGE =
  "Usage: npx tsx scripts/trust-ledger.ts append <project-id> --run <label> --facts <facts.json> --mapping-a <reader-a.toml> --mapping-b <reader-b.toml> --key <key.json> [--hidden <verdict.json>] [--pool <dir>] [--ledger <ledger.jsonl>]";

/** An append the inputs do not support; nothing is written. */
class TrustLedgerAppendRefused extends Error {
  constructor(
    readonly run: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`${COMMAND} of run ${JSON.stringify(run)}: ${detail}`, options);
    this.name = "TrustLedgerAppendRefused";
  }
}

/**
 * A reader's mapping file is not the one the ledger already records for that reader of the run and arm.
 * @testseam trust-ledger.test.ts checks a changed mapping file throws this type
 */
export class MappingDigestMismatch extends Error {
  constructor(
    readonly ledger: string,
    readonly run: string,
    readonly arm: Arm,
    readonly reader: MappingRow["reader"],
    readonly recorded: string,
    readonly read: string,
  ) {
    super(
      `${COMMAND}: the reader ${reader} mapping file of run ${run} arm ${arm} has digest ${read}, but ${JSON.stringify(ledger)} records ${recorded}; a recorded mapping is never changed`,
    );
    this.name = "MappingDigestMismatch";
  }
}

/**
 * A ledger path under the operator's hidden directory, where this command never reads or creates anything.
 * @testseam trust-ledger.test.ts checks a ledger path there is refused before anything is read
 */
export class LedgerPathRefused extends Error {
  readonly status = 2;

  constructor(
    readonly ledger: string,
    readonly hiddenRoot: string,
  ) {
    super(`${COMMAND}: the ledger ${JSON.stringify(ledger)} is under ${JSON.stringify(hiddenRoot)}, which this command never reads or writes; keep the ledger outside it`);
    this.name = "LedgerPathRefused";
  }
}

/** Assembled, never spelled whole: no trust script names the hidden directory as a place to read or write. */
const HIDDEN_DIR_NAME = ["ashara", "hidden"].join("-");

function refuseUnderHidden(ledger: string, target: string, hiddenRoot: string): void {
  const relative = path.relative(hiddenRoot, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) throw new LedgerPathRefused(ledger, hiddenRoot);
}

/**
 * Refuses a ledger under the hidden directory by its path alone, then inside a git work tree, then under the hidden
 * directory once its links are resolved: nothing is read or created at a refused path.
 */
async function refuseLedgerPath(ledger: string): Promise<void> {
  const hiddenRoot = path.join(homedir(), `.${HIDDEN_DIR_NAME}`);
  refuseUnderHidden(ledger, path.resolve(ledger), hiddenRoot);
  refuseInsideGitTree(ledger);
  let resolved: string;
  try {
    resolved = await realpath(ledger);
  } catch (err) {
    throw new TrustLedgerInvalid(ledger, "(file)", `cannot be resolved: ${describeErrorChain(err)}`, { cause: err });
  }
  refuseUnderHidden(ledger, resolved, hiddenRoot);
}

/** What only the operator knows of a run, per run and per intended guarantee. */
const factsSchema = z.strictObject({
  version: z.literal(1),
  run: idSchema,
  stage: idSchema,
  stack: pairSchema.shape.stack,
  tenderKind: pairSchema.shape.tenderKind,
  intendedSource: pairSchema.shape.intendedSource,
  custody: pairSchema.shape.custody,
  runOutcome: pairSchema.shape.runOutcome,
  intended: z
    .array(
      z.strictObject({
        id: idSchema,
        observation: observationSchema,
        adequacyGated: z.boolean(),
        suiteDefect: z.boolean(),
        firstDraft: pairSchema.shape.firstDraft,
      }),
    )
    .min(1, "the facts name no intended guarantee"),
});
type RunFacts = z.infer<typeof factsSchema>;

/** The ledger field each provider's llm_calls spend is recorded under. */
const SPEND_FIELDS: ReadonlyMap<string, keyof PairRow["spend"]> = new Map([
  ["anthropic", "claudeUsd"],
  ["deepseek", "deepseekUsd"],
]);

/**
 * Where one append reads its inputs; every path comes from the command line.
 * @testseam trust-ledger.test.ts appends fixture runs without the CLI
 */
export interface AppendOptions {
  readonly ledger: string;
  readonly projectId: ProjectId;
  readonly run: string;
  readonly poolDir: string;
  readonly facts: string;
  readonly mappingA: string;
  readonly mappingB: string;
  readonly key: string;
  readonly hidden: string | null;
  readonly now: Date;
}

type Reader = MappingRow["reader"];
type MapEntry = MappingFile["map"][number];

const READER_ROLES: Readonly<Record<Reader, MappingRow["readerRole"]>> = { A: "in-house", B: "outside" };

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

async function readFacts(file: string, run: string): Promise<RunFacts> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    throw new TrustLedgerAppendRefused(run, `the facts file ${JSON.stringify(file)} cannot be read: ${describeErrorChain(err)}`, { cause: err });
  }
  return parseJson(factsSchema, text, `${COMMAND} --facts ${file}`);
}

/** Every input names the same run and the Ashara arm, both readers mapped one packet, and all list one intended set. */
function checkInputs(pick: PickRecord, facts: RunFacts, readers: Readonly<Record<Reader, ReadMapping>>): void {
  const refuse = (detail: string): never => {
    throw new TrustLedgerAppendRefused(pick.run, detail);
  };
  if (facts.run !== pick.run) refuse(`the facts file is of run ${facts.run}`);
  for (const [reader, mapping] of Object.entries(readers)) {
    if (mapping.file.run !== pick.run) refuse(`reader ${reader}'s mapping file is of run ${mapping.file.run}`);
    if (mapping.key.run !== pick.run) refuse(`the packet key is of run ${mapping.key.run}`);
    if (mapping.key.arm !== "ashara") refuse(`the packet key is of the ${mapping.key.arm} arm; this command records the Ashara arm from its terminal report`);
  }
  if (readers.A.file.packet !== readers.B.file.packet) refuse(`readers A and B mapped different packets, ${readers.A.file.packet} and ${readers.B.file.packet}`);
  const intended = facts.intended.map((entry) => entry.id);
  if (new Set(intended).size !== intended.length) refuse("the facts file names an intended guarantee twice");
  for (const [reader, mapping] of Object.entries(readers)) {
    if (!sameSet(mapping.file.map.map((entry) => entry.intended), intended)) {
      refuse(`reader ${reader}'s mapping file maps intended guarantees ${mapping.file.map.map((entry) => entry.intended).join(", ")}, the facts name ${intended.join(", ")}`);
    }
  }
}

/**
 * The mapping rows to append: none for a reader the ledger already records with this file's digest, and a refusal for
 * one it records with another.
 */
function newMappingRows(options: AppendOptions, before: Ledger, readers: Readonly<Record<Reader, ReadMapping>>): Omit<MappingRow, "seq">[] {
  const rows: Omit<MappingRow, "seq">[] = [];
  for (const reader of ["A", "B"] as const) {
    const read = readers[reader].fileDigest;
    const recorded = before.mappings.find((row) => row.run === options.run && row.arm === "ashara" && row.reader === reader);
    if (recorded === undefined) {
      rows.push({ kind: "mapping", run: options.run, arm: "ashara", reader, readerRole: READER_ROLES[reader], fileDigest: read, createdAt: options.now.toISOString() });
    } else if (recorded.fileDigest !== read) {
      throw new MappingDigestMismatch(options.ledger, options.run, "ashara", reader, recorded.fileDigest, read);
    }
  }
  return rows;
}

/**
 * The two readings of one intended guarantee settled against the arm: unmapped when either reader mapped it to
 * nothing; when they read it otherwise, every item either named, narrowed.
 */
function settle(a: MapEntry, b: MapEntry): { readonly labels: readonly string[]; readonly narrowed: boolean; readonly agreed: boolean } {
  const agreed = sameSet(a.to, b.to) && a.narrowed === b.narrowed;
  if (a.to.length === 0 || b.to.length === 0) return { labels: [], narrowed: false, agreed };
  if (agreed) return { labels: a.to, narrowed: a.narrowed, agreed };
  return { labels: [...new Set([...a.to, ...b.to])], narrowed: true, agreed };
}

function evidenceOf(rows: readonly StoredGuaranteeVerdict[]): string {
  return [...new Set(rows.map((row) => row.evidenceClass))].sort().join("+");
}

/**
 * The run's spend per ledger field from its llm_calls totals, an unmeasured call at its worst-case estimate; spend still
 * in flight, of an unknown provider, or unmeasured with no estimate refuses.
 */
function spendOf(run: string, calls: Awaited<ReturnType<typeof readRunEvidence>>["calls"]): PairRow["spend"] {
  const spend = { claudeUsd: 0, deepseekUsd: 0 };
  for (const call of calls) {
    const field = SPEND_FIELDS.get(call.provider);
    if (field === undefined) throw new TrustLedgerAppendRefused(run, `llm_calls of provider ${call.provider} have no spend field on the ledger`);
    if (call.pendingCalls > 0) throw new TrustLedgerAppendRefused(run, `${call.pendingCalls} ${call.provider} call(s) are admitted and not yet recorded; the run's spend is not known yet`);
    if (call.zeroCostCalls > 0) throw new TrustLedgerAppendRefused(run, `${call.zeroCostCalls} ${call.provider} call(s) are priced at exactly $0, which llm_calls never records`);
    const unmeasured = call.calls - call.measuredCalls;
    if (unmeasured > 0 && call.unmeasuredEstimateUsd === 0) {
      throw new TrustLedgerAppendRefused(run, `${unmeasured} ${call.provider} call(s) are unmeasured with no worst-case estimate; their spend is unknown, never $0`);
    }
    spend[field] += call.measuredUsd + call.unmeasuredEstimateUsd;
  }
  return spend;
}

interface PairInputs {
  readonly options: AppendOptions;
  readonly pick: PickRecord;
  readonly facts: RunFacts;
  readonly readers: Readonly<Record<Reader, ReadMapping>>;
  readonly hidden: JudgedVerdict;
  readonly ashara: AsharaGuarantees;
  readonly spend: PairRow["spend"];
}

/** One pair row per intended guarantee of the facts, in their order. */
function pairRows(inputs: PairInputs): Omit<PairRow, "seq">[] {
  const { options, pick, facts, readers, hidden, ashara, spend } = inputs;
  const refuse = (detail: string): never => {
    throw new TrustLedgerAppendRefused(pick.run, detail);
  };
  if (hidden.tender !== pick.tender) refuse(`the hidden verdict judges tender ${hidden.tender}, the run picked ${pick.tender}`);
  if (ashara.kind === "no-terminal-report" && facts.runOutcome === "terminal") refuse("the facts read terminal, but the project has no terminal report on record");
  if (ashara.kind === "no-verdicts" && facts.runOutcome === "terminal") refuse(`the facts read terminal, but the project's last terminal report ${ashara.reportId} carries no guarantee verdicts`);
  const idOf = new Map(readers.A.key.items.map((item) => [item.label, item.id]));
  const rowOf = (label: string, intended: string): StoredGuaranteeVerdict => {
    const id = idOf.get(label);
    if (id === undefined) return refuse(`${intended} maps to ${label}, which the packet key does not hold`);
    const row = ashara.kind === "report" ? ashara.byId.get(id) : undefined;
    if (row === undefined) return refuse(`${intended} maps to ${label} (${id}), to which ${ashara.kind === "no-terminal-report" ? "no terminal report on record" : "the last terminal report"} gives no verdict`);
    return row;
  };
  const settled = facts.intended.map((fact) => {
    const a = readers.A.file.map.find((entry) => entry.intended === fact.id);
    const b = readers.B.file.map.find((entry) => entry.intended === fact.id);
    if (a === undefined || b === undefined) return refuse(`a reader does not map ${fact.id}`);
    return { fact, ...settle(a, b) };
  });
  const mappedLabels = new Set(settled.flatMap((entry) => entry.labels));
  const unmappedPasses = readers.A.key.items.flatMap((item) => {
    if (mappedLabels.has(item.label) || ashara.kind !== "report") return [];
    const row = ashara.byId.get(item.id);
    return row !== undefined && row.verdict === "pass" ? [row] : [];
  });
  return settled.map(({ fact, labels, narrowed, agreed }) => {
    const judged = hidden.guarantees.find((guarantee) => guarantee.id === fact.id);
    if (judged === undefined) return refuse(`the hidden verdict does not judge intended guarantee ${fact.id}`);
    const rows = labels.map((label) => rowOf(label, fact.id));
    const [first] = [...rows].sort((x, y) => (x.guaranteeId < y.guaranteeId ? -1 : x.guaranteeId > y.guaranteeId ? 1 : 0));
    const reported: PairRow["reported"] =
      first !== undefined
        ? { verdict: asharaClaim(rows), evidence: evidenceOf(rows), basis: null }
        : unmappedPasses.length > 0
          ? { verdict: "pass", evidence: evidenceOf(unmappedPasses), basis: null }
          : { verdict: "not-reported", evidence: null, basis: null };
    return {
      kind: "pair",
      stage: facts.stage,
      run: pick.run,
      arm: "ashara",
      tender: pick.tender,
      stack: facts.stack,
      tenderKind: facts.tenderKind,
      seed: pick.seed,
      commit: pick.commit,
      intended: fact.id,
      intendedSource: facts.intendedSource,
      custody: facts.custody,
      mapped: { to: first === undefined ? null : first.guaranteeId, narrowed, agreed },
      reported,
      hidden: { verdict: judged.verdict, adequacyGated: fact.adequacyGated, suiteDefect: fact.suiteDefect, reason: judged.reason ?? null },
      observation: fact.observation,
      firstDraft: fact.firstDraft,
      spend,
      runOutcome: facts.runOutcome,
      createdAt: options.now.toISOString(),
    };
  });
}

/**
 * Appends the Ashara arm of one run to the ledger: its mapping rows, and with a hidden verdict its pair rows. Returns
 * how many rows were appended; zero leaves the file untouched.
 * @testseam trust-ledger.test.ts appends fixture runs without the CLI
 */
export async function appendRun(db: DbHandle, options: AppendOptions): Promise<number> {
  await refuseLedgerPath(options.ledger);
  const text = await readLedgerText(options.ledger);
  const before = parseLedger(options.ledger, text);
  const readers = {
    A: await readMapping(options.mappingA, options.key, COMMAND),
    B: await readMapping(options.mappingB, options.key, COMMAND),
  };
  const pick = await recordedPick(options.poolDir, options.run);
  const facts = await readFacts(options.facts, options.run);
  const hidden = options.hidden === null ? null : await readHidden(options.hidden, COMMAND);
  checkInputs(pick, facts, readers);

  const rows: Omit<LedgerRow, "seq">[] = newMappingRows(options, before, readers);
  if (hidden !== null) {
    const recorded = before.pairs.filter((row) => row.run === pick.run && row.arm === "ashara").map((row) => row.intended);
    if (recorded.length === 0) {
      const ashara = asharaGuaranteesOf(options.projectId, await lastReportGuaranteeVerdictsOf(db, options.projectId));
      const spend = spendOf(pick.run, (await readRunEvidence(db, options.projectId, projectHalted, projectWorkItems)).calls);
      rows.push(...pairRows({ options, pick, facts, readers, hidden, ashara, spend }));
    } else if (!sameSet(recorded, facts.intended.map((entry) => entry.id))) {
      throw new TrustLedgerAppendRefused(pick.run, `the ledger records pair rows for ${recorded.join(", ")}, not the intended guarantees the facts name`);
    }
  }
  if (rows.length === 0) return 0;
  const last = before.prereg.length + before.mappings.length + before.pairs.length;
  const appended = rows.map((row, index) => `${JSON.stringify({ ...row, seq: last + index + 1 })}\n`).join("");
  parseLedger(options.ledger, text + appended);
  await appendFile(options.ledger, appended);
  return rows.length;
}

const FLAGS = ["--run", "--facts", "--mapping-a", "--mapping-b", "--key", "--hidden", "--pool", "--ledger"];

function parseCli(argv: readonly string[], env: NodeJS.ProcessEnv): AppendOptions {
  const [command, project, ...rest] = argv;
  if (command !== "append" || project === undefined || project.startsWith("--")) throw new TrustLedgerAppendRefused("(none)", `append takes a project id first. ${USAGE}`);
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === undefined || !FLAGS.includes(flag) || value === undefined || value === "" || values.has(flag)) {
      throw new TrustLedgerAppendRefused("(none)", `unexpected argument ${JSON.stringify(flag)}. ${USAGE}`);
    }
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new TrustLedgerAppendRefused("(none)", `${flag} is required. ${USAGE}`);
    return value;
  };
  const ledger = values.get("--ledger") ?? env["ASHARA_TRUST_LEDGER"];
  if (ledger === undefined || ledger === "") throw new TrustLedgerAppendRefused("(none)", `the ledger is given by --ledger or ASHARA_TRUST_LEDGER; neither is set. ${USAGE}`);
  return {
    ledger,
    projectId: parseProjectId(project, `${COMMAND} <project-id> argument`),
    run: required("--run"),
    poolDir: poolDirOf(values.get("--pool"), env),
    facts: required("--facts"),
    mappingA: required("--mapping-a"),
    mappingB: required("--mapping-b"),
    key: required("--key"),
    hidden: values.get("--hidden") ?? null,
    now: new Date(),
  };
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const options = parseCli(argv, process.env);
    const db = createDb(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
    try {
      const appended = await appendRun(db, options);
      console.log(appended === 0 ? `${COMMAND}: nothing to append to ${options.ledger}` : `${COMMAND}: appended ${appended} row(s) to ${options.ledger}`);
    } finally {
      await db.$client.end();
    }
    return 0;
  } catch (err) {
    console.error(describeErrorChain(err));
    return err instanceof PoolMappingRefused || err instanceof LedgerPathRefused ? err.status : 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (status) => {
      process.exitCode = status;
    },
    (err: unknown) => {
      console.error(describeErrorChain(err));
      process.exitCode = 1;
    },
  );
}

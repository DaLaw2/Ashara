/**
 * Which tender of the pool a real run posts, and the record of that pick. The pool directory holds `pool.toml` (the
 * tenders, by id) and `ledger.jsonl` (one pick per line, appended here). A run takes a tender with the fewest picks in
 * the ledger; among those it draws with its seed, sha256 of the run label followed by the commit, so the same run on
 * the same commit picks the same tender. A pinned run takes the tender it names and records why. The ledger is the
 * count of past runs: a missing or unreadable pool or ledger stops the pick, never reads as a pool with no runs.
 */

import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { describeErrorChain, JsonParseFailed, parseJson } from "@ashara/shared";

const POOL_FILE = "pool.toml";
const LEDGER_FILE = "ledger.jsonl";

class TenderPoolInvalid extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`tender pool: ${JSON.stringify(path)} cannot be used: ${detail}`, options);
    this.name = "TenderPoolInvalid";
  }
}

class TenderPickRefused extends Error {
  constructor(readonly detail: string) {
    super(`tender pool: no pick: ${detail}`);
    this.name = "TenderPickRefused";
  }
}

const tenderIdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/, "a tender id is letters, digits, '.', '_' or '-'");

const poolSchema = z.object({
  version: z.literal(1),
  tender: z
    .array(z.object({ id: tenderIdSchema, name: z.string().min(1), dir: z.string().min(1) }))
    .min(1, "the pool names no tender")
    .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, "tender ids must be unique"),
});

export interface PoolTender {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
}

const pickRecordSchema = z.object({
  kind: z.literal("pick"),
  run: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{7,64}$/, "a commit is lowercase hex"),
  tender: tenderIdSchema,
  seed: z.string().regex(/^[0-9a-f]{64}$/, "a seed is a sha256 hex digest"),
  reason: z.string().min(1),
  at: z.string().min(1),
});
export type PickRecord = z.infer<typeof pickRecordSchema>;

/** Reads the pool's tenders; the canary and every other suite detail are left unread. */
export async function readPool(poolDir: string): Promise<readonly PoolTender[]> {
  const path = join(poolDir, POOL_FILE);
  let raw: unknown;
  try {
    raw = parseToml(await readFile(path, "utf8"));
  } catch (err) {
    throw new TenderPoolInvalid(path, `it cannot be read as TOML: ${describeErrorChain(err)}`, { cause: err });
  }
  const parsed = poolSchema.safeParse(raw);
  if (!parsed.success) throw new TenderPoolInvalid(path, parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "));
  return parsed.data.tender.map((entry) => ({ id: entry.id, name: entry.name, dir: entry.dir }));
}

/** Every pick recorded so far. An empty file is a ledger with no runs; a missing one is an error. */
export async function readLedger(poolDir: string): Promise<readonly PickRecord[]> {
  const path = join(poolDir, LEDGER_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new TenderPoolInvalid(path, `the ledger cannot be read (start a new ledger as an empty file): ${describeErrorChain(err)}`, { cause: err });
  }
  if (text !== "" && !text.endsWith("\n")) throw new TenderPoolInvalid(path, "the ledger's last line is unterminated (a partly written pick)");
  const lines = text === "" ? [] : text.slice(0, -1).split("\n");
  return lines.map((line, index) => {
    try {
      return parseJson(pickRecordSchema, line, `${path} line ${index + 1}`);
    } catch (err) {
      if (!(err instanceof JsonParseFailed)) throw err;
      throw new TenderPoolInvalid(path, describeErrorChain(err), { cause: err });
    }
  });
}

function seedOf(run: string, commit: string): string {
  return createHash("sha256").update(`${run}${commit}`).digest("hex");
}

export interface PickRequest {
  readonly run: string;
  readonly commit: string;
  /** A run aimed at one defect names its tender and why. */
  readonly pin?: { readonly tender: string; readonly reason: string };
  readonly at: string;
}

/** The pick for this run from the pool and the ledger. Pure: nothing is read or written. */
export function pickTender(pool: readonly PoolTender[], ledger: readonly PickRecord[], request: PickRequest): PickRecord {
  if (request.run === "") throw new TenderPickRefused("the run label is empty");
  const commit = pickRecordSchema.shape.commit.safeParse(request.commit);
  if (!commit.success) throw new TenderPickRefused(`the commit ${JSON.stringify(request.commit)} is not lowercase hex of 7 to 64 digits`);
  const earlier = ledger.find((record) => record.run === request.run);
  if (earlier !== undefined) throw new TenderPickRefused(`run ${JSON.stringify(request.run)} already picked ${earlier.tender} at ${earlier.at}`);
  const unknown = ledger.filter((record) => !pool.some((tender) => tender.id === record.tender));
  if (unknown.length > 0) throw new TenderPickRefused(`the ledger names tender(s) the pool does not: ${[...new Set(unknown.map((record) => record.tender))].join(", ")}`);
  const seed = seedOf(request.run, request.commit);
  const base = { kind: "pick" as const, run: request.run, commit: request.commit, seed, at: request.at };
  if (request.pin !== undefined) {
    const { tender, reason } = request.pin;
    if (!pool.some((entry) => entry.id === tender)) throw new TenderPickRefused(`the pinned tender ${JSON.stringify(tender)} is not in the pool`);
    if (reason.trim() === "") throw new TenderPickRefused("a pinned pick needs its reason");
    return { ...base, tender, reason: `pinned: ${reason}` };
  }
  const runs = new Map(pool.map((tender) => [tender.id, ledger.filter((record) => record.tender === tender.id).length]));
  const fewest = Math.min(...runs.values());
  const candidates = pool.filter((tender) => runs.get(tender.id) === fewest).map((tender) => tender.id).sort();
  const index = Number(BigInt(`0x${seed}`) % BigInt(candidates.length));
  const tender = candidates[index];
  if (tender === undefined) throw new TenderPickRefused("no candidate tender (the pool is empty)");
  return { ...base, tender, reason: `fewest runs (${fewest}) among ${candidates.join(", ")}; drawn by seed` };
}

export async function appendPick(poolDir: string, record: PickRecord): Promise<void> {
  await appendFile(join(poolDir, LEDGER_FILE), `${JSON.stringify(pickRecordSchema.parse(record))}\n`);
}

/** The pick a run recorded, by its label; a label the ledger does not hold is an error. */
export async function recordedPick(poolDir: string, run: string): Promise<PickRecord> {
  const found = (await readLedger(poolDir)).filter((record) => record.run === run);
  const [pick] = found;
  if (pick === undefined) throw new TenderPickRefused(`the ledger in ${JSON.stringify(poolDir)} records no pick for run ${JSON.stringify(run)}`);
  if (found.length > 1) throw new TenderPickRefused(`the ledger records run ${JSON.stringify(run)} ${found.length} times`);
  return pick;
}

/** The pool directory: the --pool argument, else ASHARA_TENDER_POOL; never a path in this repository. */
export function poolDirOf(argument: string | undefined, env: NodeJS.ProcessEnv): string {
  const dir = argument ?? env["ASHARA_TENDER_POOL"];
  if (dir === undefined || dir === "") throw new TenderPickRefused("the pool directory is given by --pool or ASHARA_TENDER_POOL; neither is set");
  return dir;
}

/**
 * The blind two-reader mapping of one run and arm: the packet a reader maps from, the file a reader writes back, and
 * the seeded order the packet shows the arm's items in.
 *
 *   npx tsx scripts/pool-mapping.ts export --source <source.json> --seed <hex64> --packet <packet.json> --key <key.json>
 *   npx tsx scripts/pool-mapping.ts check --packet <packet.json> --mapping <reader.toml>
 *
 * `export` reads the judge's source file (the intended list and the arm's items with what the arm reported for each)
 * and writes two new files. The packet holds the run, the intended list and each item's statement and observations,
 * relabelled `item-1..` in the reading order; it holds no verdict, evidence class, basis, arm name or item id of the
 * arm, so a reader cannot tell which arm wrote the items or what either judge said. The key, which only the judge
 * keeps, names the arm and joins each label back to the arm's own item id. Neither file is ever written inside a git
 * work tree, ignored path or not, so a packet can never be committed to the published repository, and neither
 * overwrites an existing file, so a packet a reader already holds is never silently replaced.
 *
 * The reading order sorts the arm's items by sha256 of the seed, a NUL and the item's id: the same seed and items give
 * the same order, and the arm is no input to it, so the order tells a reader nothing about the arm.
 *
 * `check` validates a reader's mapping file against the packet and prints the mapping file's digest for its ledger row.
 * The file is TOML: `version = 1`, `run`, `packet` (the packet file's digest), and one `[[map]]` table per intended
 * guarantee with `intended`, `to` (the packet labels it maps to; empty when no item covers it) and `narrowed`. Every
 * intended id of the packet appears exactly once; anything else is refused with MappingFileInvalid naming the id.
 *
 * Paths come only from the arguments. Exit status: 0 done; 1 a usage error, an unreadable or invalid input, a mapping
 * file refused; 2 an output path inside a git work tree, already existing, or whose tree cannot be determined.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { describeErrorChain, parseJson } from "@ashara/shared";

const USAGE = [
  "Usage: npx tsx scripts/pool-mapping.ts export --source <source.json> --seed <hex64> --packet <packet.json> --key <key.json>",
  "       npx tsx scripts/pool-mapping.ts check --packet <packet.json> --mapping <reader.toml>",
].join("\n");

/** A refused command, with the exit status it ends with. */
export class PoolMappingRefused extends Error {
  constructor(
    readonly status: 1 | 2,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`pool-mapping: ${detail}`, options);
    this.name = "PoolMappingRefused";
  }
}

/** A reader's mapping file refused, naming the intended id at fault when one is. */
export class MappingFileInvalid extends Error {
  constructor(
    readonly source: string,
    readonly intended: string | null,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`mapping file ${JSON.stringify(source)}: ${intended === null ? "" : `intended ${intended}: `}${detail}`, options);
    this.name = "MappingFileInvalid";
  }
}

const idSchema = z.string().regex(/^[A-Za-z0-9._-]+$/, "an id is letters, digits, '.', '_' or '-'");
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "a digest is sha256: and 64 lowercase hex digits");
const seedSchema = z.string().regex(/^[0-9a-f]{64}$/, "a seed is 64 lowercase hex digits");
const labelSchema = z.string().regex(/^item-[1-9][0-9]*$/, "an item label is item- and a positive number");
const textSchema = z.string().trim().min(1);
/** The arms a run is measured under; the trust ledger records the same vocabulary. */
export const armSchema = z.enum(["ashara", "baseline", "qa3"]);

function unique(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

const intendedSchema = z
  .array(z.strictObject({ id: idSchema, statement: textSchema }))
  .min(1, "the intended list is empty")
  .refine((entries) => unique(entries.map((entry) => entry.id)) === undefined, "intended ids are unique");

const sourceSchema = z.strictObject({
  version: z.literal(1),
  run: idSchema,
  arm: armSchema,
  intended: intendedSchema,
  /** The arm's items as it reported them; an arm that posted no report has none, and every intended id maps to none. */
  items: z
    .array(
      z.strictObject({
        id: idSchema,
        statement: textSchema,
        observations: z.array(textSchema),
        verdict: z.enum(["pass", "fail", "unjudged"]),
        evidence: textSchema.nullable(),
        basis: textSchema.nullable(),
      }),
    )
    .refine((items) => unique(items.map((item) => item.id)) === undefined, "item ids are unique"),
});
type PacketSource = z.infer<typeof sourceSchema>;

const packetSchema = z.strictObject({
  version: z.literal(1),
  run: idSchema,
  intended: intendedSchema,
  items: z.array(z.strictObject({ label: labelSchema, statement: textSchema, observations: z.array(textSchema) })),
});
type MappingPacket = z.infer<typeof packetSchema>;

const keySchema = z.strictObject({
  version: z.literal(1),
  run: idSchema,
  arm: armSchema,
  items: z.array(z.strictObject({ label: labelSchema, id: idSchema })),
});
export type PacketKey = z.infer<typeof keySchema>;

const mappingFileSchema = z.strictObject({
  version: z.literal(1),
  run: idSchema,
  packet: digestSchema,
  map: z.array(z.strictObject({ intended: idSchema, to: z.array(labelSchema), narrowed: z.boolean() })),
});
export type MappingFile = z.infer<typeof mappingFileSchema>;

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The digest a ledger row and a mapping file name a file by: `sha256:` and the hex sha256 of its bytes. */
export function digestOf(data: string | Buffer): string {
  return `sha256:${sha256(data)}`;
}

/**
 * The order a packet shows the arm's items in: by sha256 of the seed, a NUL and the item id.
 * @testseam pool-mapping.test.ts checks the order against a fixed expectation
 */
export function readingOrder(seed: string, ids: readonly string[]): readonly string[] {
  const valid = seedSchema.safeParse(seed);
  if (!valid.success) throw new PoolMappingRefused(1, `the seed is not 64 lowercase hex digits: ${JSON.stringify(seed)}`);
  return ids
    .map((id) => ({ id, rank: sha256(`${valid.data}\0${id}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((entry) => entry.id);
}

/**
 * The packet and its key; the packet is built from statements and observations alone, never from the source item.
 * @testseam pool-mapping.test.ts walks the packet for a leaked verdict, evidence class or arm name
 */
export function exportPacket(source: unknown, seed: string): { readonly packet: MappingPacket; readonly key: PacketKey } {
  const result = sourceSchema.safeParse(source);
  if (!result.success) {
    throw new PoolMappingRefused(1, `the source is invalid: ${result.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
  }
  const parsed: PacketSource = result.data;
  const byId = new Map(parsed.items.map((item) => [item.id, item]));
  const ordered = readingOrder(seed, parsed.items.map((item) => item.id)).map((id, index) => {
    const item = byId.get(id);
    if (item === undefined) throw new PoolMappingRefused(1, `the reading order names item ${id}, which the source does not hold`);
    return { label: `item-${index + 1}`, item };
  });
  return {
    packet: {
      version: 1,
      run: parsed.run,
      intended: parsed.intended.map((entry) => ({ id: entry.id, statement: entry.statement })),
      items: ordered.map(({ label, item }) => ({ label, statement: item.statement, observations: [...item.observations] })),
    },
    key: { version: 1, run: parsed.run, arm: parsed.arm, items: ordered.map(({ label, item }) => ({ label, id: item.id })) },
  };
}

/**
 * The packet file's text; its digest is the one a mapping file names.
 * @testseam pool-mapping.test.ts digests fixture packets with it
 */
export function packetText(packet: MappingPacket): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

/**
 * A reader's mapping file read on its own, without the packet it was read from: TOML of the mapping file schema, every
 * intended id at most once, no label twice in one entry, and no narrowed entry that maps to no item.
 */
export function readMappingFile(text: string, source: string): MappingFile {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (err) {
    throw new MappingFileInvalid(source, null, `not TOML: ${describeErrorChain(err)}`, { cause: err });
  }
  const parsed = mappingFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MappingFileInvalid(source, null, parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("; "));
  }
  const seen = new Set<string>();
  for (const entry of parsed.data.map) {
    if (seen.has(entry.intended)) throw new MappingFileInvalid(source, entry.intended, "is mapped twice; every intended id appears exactly once");
    seen.add(entry.intended);
    const repeated = unique(entry.to);
    if (repeated !== undefined) throw new MappingFileInvalid(source, entry.intended, `maps to ${repeated} twice`);
    if (entry.narrowed && entry.to.length === 0) throw new MappingFileInvalid(source, entry.intended, "is narrowed but maps to no item");
  }
  return parsed.data;
}

/** The key a packet was exported with, which joins each packet label back to the arm's own item id. */
export function readPacketKey(text: string, source: string): PacketKey {
  return parseJson(keySchema, text, source);
}

/**
 * A reader's mapping file, checked against the packet it was read from: the run and packet digest match, every intended
 * id of the packet appears exactly once and no other, and every label it maps to is one of the packet's items.
 * @testseam pool-mapping.test.ts checks a missing or repeated intended id is refused
 */
export function parseMappingFile(text: string, source: string, packet: MappingPacket, packetDigest: string): MappingFile {
  const file = readMappingFile(text, source);
  if (file.run !== packet.run) throw new MappingFileInvalid(source, null, `run ${file.run} is not the packet's run ${packet.run}`);
  if (file.packet !== packetDigest) throw new MappingFileInvalid(source, null, `packet ${file.packet} is not the packet read, ${packetDigest}`);
  const intended = new Set(packet.intended.map((entry) => entry.id));
  const labels = new Set(packet.items.map((item) => item.label));
  const seen = new Set<string>();
  for (const entry of file.map) {
    if (!intended.has(entry.intended)) throw new MappingFileInvalid(source, entry.intended, "is not on the packet's intended list");
    seen.add(entry.intended);
    const unknown = entry.to.find((label) => !labels.has(label));
    if (unknown !== undefined) throw new MappingFileInvalid(source, entry.intended, `maps to ${unknown}, which the packet does not hold`);
  }
  const missing = packet.intended.find((entry) => !seen.has(entry.id));
  if (missing !== undefined) throw new MappingFileInvalid(source, missing.id, "is missing; every intended id appears exactly once");
  return file;
}

/** The environment git runs in: a caller's GIT_DIR or work tree would answer for another repository than asked. */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))), LC_ALL: "C", LANGUAGE: "C" };
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/**
 * `file` with every symbolic link resolved. A path that does not exist yet resolves through its nearest existing
 * ancestor, and a dangling link through its target, so a path is judged where a write to it would land.
 */
export function realPathOf(file: string): string {
  const target = path.resolve(file);
  try {
    return realpathSync(target);
  } catch (err) {
    if (!isMissing(err)) throw new PoolMappingRefused(2, `cannot resolve the links of ${target}: ${describeErrorChain(err)}`, { cause: err });
  }
  const parent = path.dirname(target);
  if (parent === target) throw new PoolMappingRefused(2, `cannot resolve the links of ${target}: the root does not exist`);
  try {
    if (lstatSync(target).isSymbolicLink()) return realPathOf(path.resolve(parent, readlinkSync(target)));
  } catch (err) {
    if (!isMissing(err)) throw new PoolMappingRefused(2, `cannot resolve the links of ${target}: ${describeErrorChain(err)}`, { cause: err });
  }
  return path.join(realPathOf(parent), path.basename(target));
}

/**
 * Refuses a path inside any git work tree, ignored or not, judged at `file` with every link resolved: a packet, key or
 * trust ledger holds hidden material. `what` names the file in the refusal.
 */
export function refuseInsideGitTree(file: string, what: string): void {
  const target = realPathOf(file);
  const checked = `the ${what} ${JSON.stringify(file)}, resolved to ${target},`;
  const top = spawnSync("git", ["-C", path.dirname(target), "rev-parse", "--show-toplevel"], { encoding: "utf8", env: gitEnv() });
  if (top.error !== undefined) throw new PoolMappingRefused(2, `cannot run git to check whether ${checked} is in a git work tree: ${top.error.message}`, { cause: top.error });
  if (top.status === 0) throw new PoolMappingRefused(2, `${checked} is inside the git work tree ${top.stdout.trim()}; keep the ${what} outside every work tree`);
  if (!/not a git repository/.test(top.stderr)) throw new PoolMappingRefused(2, `cannot tell whether ${checked} is in a git work tree: ${top.stderr.trim()}`);
}

async function writeNew(out: string, text: string): Promise<void> {
  try {
    await writeFile(path.resolve(out), text, { flag: "wx" });
  } catch (err) {
    throw new PoolMappingRefused(2, `cannot create ${path.resolve(out)} (an existing file is never replaced): ${describeErrorChain(err)}`, { cause: err });
  }
}

/** Refuses before either file is written, so a refused export never leaves one of the pair behind. */
async function refuseExisting(outs: readonly string[]): Promise<void> {
  for (const out of outs) {
    const target = path.resolve(out);
    try {
      await lstat(target);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") continue;
      throw new PoolMappingRefused(2, `cannot tell whether ${target} exists: ${describeErrorChain(err)}`, { cause: err });
    }
    throw new PoolMappingRefused(2, `${target} already exists; an existing file is never replaced`);
  }
}

async function readText(file: string, what: string): Promise<string> {
  try {
    return await readFile(path.resolve(file), "utf8");
  } catch (err) {
    throw new PoolMappingRefused(1, `cannot read the ${what} ${path.resolve(file)}: ${describeErrorChain(err)}`, { cause: err });
  }
}

function flags(argv: readonly string[], allowed: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !allowed.includes(flag) || value === undefined || value === "" || values.has(flag)) {
      throw new PoolMappingRefused(1, `unexpected argument ${JSON.stringify(flag)}.\n${USAGE}`);
    }
    values.set(flag, value);
  }
  const absent = allowed.find((flag) => !values.has(flag));
  if (absent !== undefined) throw new PoolMappingRefused(1, `${absent} is required.\n${USAGE}`);
  return values;
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) throw new PoolMappingRefused(1, `${flag} is required.\n${USAGE}`);
  return value;
}

async function exportCommand(argv: readonly string[]): Promise<void> {
  const values = flags(argv, ["--source", "--seed", "--packet", "--key"]);
  const packetPath = required(values, "--packet");
  const keyPath = required(values, "--key");
  if (path.resolve(packetPath) === path.resolve(keyPath)) throw new PoolMappingRefused(1, "--packet and --key name the same file");
  refuseInsideGitTree(packetPath, "packet");
  refuseInsideGitTree(keyPath, "packet key");
  const sourcePath = required(values, "--source");
  const source = parseJson(z.unknown(), await readText(sourcePath, "source"), path.resolve(sourcePath));
  const { packet, key } = exportPacket(source, required(values, "--seed"));
  await refuseExisting([packetPath, keyPath]);
  const text = packetText(packet);
  await writeNew(keyPath, `${JSON.stringify(key, null, 2)}\n`);
  await writeNew(packetPath, text);
  console.log(`${digestOf(text)}  ${path.resolve(packetPath)}`);
}

async function checkCommand(argv: readonly string[]): Promise<void> {
  const values = flags(argv, ["--packet", "--mapping"]);
  const packetPath = path.resolve(required(values, "--packet"));
  const mappingPath = path.resolve(required(values, "--mapping"));
  const packetBody = await readText(packetPath, "packet");
  const packet = parseJson(packetSchema, packetBody, packetPath);
  const mappingBody = await readText(mappingPath, "mapping file");
  parseMappingFile(mappingBody, mappingPath, packet, digestOf(packetBody));
  console.log(`${digestOf(mappingBody)}  ${mappingPath}`);
}

/** The export or check command, its arguments after the script name; resolves to the exit status above. */
export async function poolMappingMain(argv: readonly string[]): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === "export") await exportCommand(rest);
    else if (command === "check") await checkCommand(rest);
    else throw new PoolMappingRefused(1, `unknown command ${JSON.stringify(command)}.\n${USAGE}`);
    return 0;
  } catch (err) {
    console.error(describeErrorChain(err));
    return err instanceof PoolMappingRefused ? err.status : 1;
  }
}

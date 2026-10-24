// Makes a git worktree's node_modules usable offline in seconds. Every external package is a symlink
// to the main checkout's installed copy; every workspace package link points at the worktree's own
// package directory, so typecheck and knip resolve @ashara/* to the code under review.
//
// An external package is the main checkout's own directory, not a copy: a tool that writes inside
// a package directory (a cache, a postinstall rebuild, a patch) writes into the main checkout's
// install, for every worktree that links it.
//
// The records are gitignored (docs/, CLAUDE.md, .claude/commands/), so a worktree has none of its
// own: each is a symlink to the main checkout's copy, and an agent in the worktree reads the same
// records and runs the same doc gate, whose verify commands name them relative to the checkout.
// They are shared, not copies: a write under <worktree>/docs (or either other link) writes the main
// checkout's records. An existing record path that is anything other than that link is refused,
// never replaced, before anything is written. A record the main checkout lacks gets no link, and
// the summary says so.
//
// The main checkout's install is reused only when its node_modules/.package-lock.json records the
// same packages as its package-lock.json; an install that drifted from its lockfile is refused,
// naming npm ci in the main checkout.
//
// Run with plain node (type stripping), never tsx: a fresh worktree has no node_modules to load tsx
// from. For the same reason it imports node built-ins and the doc gate's scope module only.
//
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/worktree-setup.ts <worktree-dir> [--source <checkout-with-node_modules>]
// The source defaults to the main checkout of the worktree's repository.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

class WorktreeSetupError extends Error {
  readonly step: string;
  readonly worktree: string;

  constructor(step: string, worktree: string, detail: string) {
    super(`${step} failed for ${worktree}: ${detail}`);
    this.name = "WorktreeSetupError";
    this.step = step;
    this.worktree = worktree;
  }
}

interface Cli {
  readonly dir: string;
  readonly source: string | undefined;
}

interface LinkCounts {
  external: number;
  workspace: number;
  bin: number;
}

const USAGE = "usage: just worktree-setup <worktree-dir>, or node scripts/worktree-setup.ts <worktree-dir> [--source <checkout-with-node_modules>]";

function parseCli(argv: readonly string[]): Cli {
  let dir: string | undefined;
  let source: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source") {
      source = argv[++i];
      if (source === undefined) throw new WorktreeSetupError("arguments", "(none)", `--source needs a directory; ${USAGE}`);
    } else if (arg !== undefined && !arg.startsWith("-") && dir === undefined) dir = arg;
    else throw new WorktreeSetupError("arguments", "(none)", `unexpected ${String(arg)}; ${USAGE}`);
  }
  if (dir === undefined) throw new WorktreeSetupError("arguments", "(none)", `a worktree directory is required; ${USAGE}`);
  return { dir, source };
}

function realDirectory(dir: string, step: string, worktree: string): string {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch (error) {
    throw new WorktreeSetupError(step, worktree, `${dir} does not exist (${String(error instanceof Error ? error.message : error)})`);
  }
  if (!fs.statSync(real).isDirectory()) throw new WorktreeSetupError(step, worktree, `${dir} is not a directory`);
  return real;
}

function mainCheckoutOf(worktree: string): string {
  let commonDir: string;
  try {
    commonDir = execFileSync("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    throw new WorktreeSetupError("main checkout", worktree, `git rev-parse --git-common-dir failed, so this is not a git worktree: ${String(error instanceof Error ? error.message : error)}`);
  }
  if (path.basename(commonDir) !== ".git") {
    throw new WorktreeSetupError("main checkout", worktree, `the repository's common git dir ${commonDir} is not a checkout's .git, so there is no main checkout to reuse; pass --source <checkout> or run npm ci in ${worktree}`);
  }
  return realDirectory(path.dirname(commonDir), "main checkout", worktree);
}

function readLockfile(checkout: string, worktree: string): Buffer {
  const file = path.join(checkout, "package-lock.json");
  try {
    return fs.readFileSync(file);
  } catch (error) {
    throw new WorktreeSetupError("lockfile", worktree, `cannot read ${file} (${String(error instanceof Error ? error.message : error)}); run npm ci in ${worktree}`);
  }
}

type LockEntries = ReadonlyMap<string, Readonly<Record<string, unknown>>>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Plain node cannot load zod or @ashara/shared before node_modules exists, so the lockfile shape
// is narrowed by hand: a `packages` object whose every value is an object.
function lockEntries(text: string, file: string, worktree: string, fix: string): LockEntries {
  let parsed: unknown;
  try {
    // eslint-disable-next-line no-restricted-syntax -- parsed into unknown and narrowed by isRecord below; parseJson is not loadable before node_modules exists
    parsed = JSON.parse(text);
  } catch (error) {
    throw new WorktreeSetupError("install drift", worktree, `${file} is not valid JSON (${String(error instanceof Error ? error.message : error)}); ${fix}`);
  }
  const packages = isRecord(parsed) ? parsed["packages"] : undefined;
  if (!isRecord(packages)) throw new WorktreeSetupError("install drift", worktree, `${file} has no packages object; ${fix}`);
  const entries = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [key, entry] of Object.entries(packages)) {
    if (!isRecord(entry)) throw new WorktreeSetupError("install drift", worktree, `${file} entry ${JSON.stringify(key)} is not an object; ${fix}`);
    entries.set(key, entry);
  }
  return entries;
}

// The root entry ("") holds the project's own manifest fields (engines, dependency ranges), which
// select nothing on disk; every other entry is an installed package, compared in full.
function lockedPackageDiff(sourceLock: Buffer, source: string, worktreeLock: Buffer, worktree: string): string[] {
  const fix = `run npm ci in ${worktree}`;
  const ours = lockEntries(sourceLock.toString("utf8"), path.join(source, "package-lock.json"), worktree, fix);
  const theirs = lockEntries(worktreeLock.toString("utf8"), path.join(worktree, "package-lock.json"), worktree, fix);
  const keys = new Set([...ours.keys(), ...theirs.keys()]);
  keys.delete("");
  return [...keys].filter((key) => JSON.stringify(canonical(ours.get(key))) !== JSON.stringify(canonical(theirs.get(key))));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

const IDENTITY_FIELDS = ["version", "resolved", "integrity", "link"] as const;

// npm records what it installed in node_modules/.package-lock.json. Every installed entry must
// match the lockfile's entry field by field, and every lockfile entry must be installed unless it
// is optional (a platform package npm skips on this machine) or the root project itself.
function installDrift(lock: LockEntries, installed: LockEntries): string[] {
  const drift: string[] = [];
  for (const [key, entry] of installed) {
    const locked = lock.get(key);
    if (locked === undefined) {
      drift.push(`${key} is installed but not in package-lock.json`);
      continue;
    }
    for (const field of IDENTITY_FIELDS) {
      if (entry[field] !== locked[field]) drift.push(`${key} ${field} is ${String(entry[field])} installed, ${String(locked[field])} locked`);
    }
  }
  for (const [key, locked] of lock) {
    if (key === "" || installed.has(key) || locked["optional"] === true || locked["devOptional"] === true) continue;
    drift.push(`${key} is in package-lock.json but not installed`);
  }
  return drift;
}

function checkInstall(source: string, sourceModules: string, sourceLock: Buffer, worktree: string): void {
  const fix = `run npm ci in ${source}`;
  const hiddenFile = path.join(sourceModules, ".package-lock.json");
  let hidden: string;
  try {
    hidden = fs.readFileSync(hiddenFile, "utf8");
  } catch (error) {
    throw new WorktreeSetupError("install drift", worktree, `cannot read ${hiddenFile} (${String(error instanceof Error ? error.message : error)}), so ${source}'s install cannot be matched to its lockfile; ${fix}`);
  }
  const drift = installDrift(lockEntries(sourceLock.toString("utf8"), path.join(source, "package-lock.json"), worktree, fix), lockEntries(hidden, hiddenFile, worktree, fix));
  if (drift.length > 0) {
    const shown = drift.slice(0, 5).join("; ");
    const more = drift.length > 5 ? ` (and ${drift.length - 5} more)` : "";
    throw new WorktreeSetupError("install drift", worktree, `${source}'s node_modules does not match its package-lock.json: ${shown}${more}; ${fix}`);
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** What every entry of one populate run is linked against, and the tally it adds to. */
interface LinkScope {
  readonly source: string;
  readonly sourceModules: string;
  readonly worktree: string;
  readonly counts: LinkCounts;
}

// A source entry that is a symlink into the source checkout outside its node_modules is a workspace
// link; it is recreated against the same relative directory in the worktree. Every other entry is
// linked to the source's installed copy.
function linkEntry(srcEntry: string, dstEntry: string, scope: LinkScope): void {
  const { source, sourceModules, worktree, counts } = scope;
  if (fs.lstatSync(srcEntry).isSymbolicLink()) {
    const target = path.resolve(path.dirname(srcEntry), fs.readlinkSync(srcEntry));
    if (isInside(target, source) && !isInside(target, sourceModules)) {
      const own = path.join(worktree, path.relative(source, target));
      if (!fs.existsSync(own)) {
        throw new WorktreeSetupError("workspace link", worktree, `${srcEntry} links workspace ${path.relative(source, target)}, which ${worktree} does not have; run npm ci in ${worktree}`);
      }
      fs.symlinkSync(path.relative(path.dirname(dstEntry), own), dstEntry);
      counts.workspace++;
      return;
    }
  }
  fs.symlinkSync(srcEntry, dstEntry);
  counts.external++;
}

// Bin entries keep their relative link text, so each resolves through the worktree's own package
// links: a workspace package's bin runs the worktree's code.
function linkBins(srcBin: string, dstBin: string, counts: LinkCounts): void {
  fs.mkdirSync(dstBin);
  for (const name of fs.readdirSync(srcBin)) {
    const srcEntry = path.join(srcBin, name);
    const dstEntry = path.join(dstBin, name);
    if (fs.lstatSync(srcEntry).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(srcEntry), dstEntry);
    else fs.symlinkSync(srcEntry, dstEntry);
    counts.bin++;
  }
}

// Dot entries other than .bin and npm's hidden lockfile are tool caches (.vite, .cache); the worktree
// builds its own rather than writing into the source's.
function populate(staging: string, source: string, sourceModules: string, worktree: string): LinkCounts {
  const counts: LinkCounts = { external: 0, workspace: 0, bin: 0 };
  const scope: LinkScope = { source, sourceModules, worktree, counts };
  for (const entry of fs.readdirSync(sourceModules, { withFileTypes: true })) {
    const srcEntry = path.join(sourceModules, entry.name);
    const dstEntry = path.join(staging, entry.name);
    if (entry.name === ".bin") linkBins(srcEntry, dstEntry, counts);
    else if (entry.name === ".package-lock.json") fs.copyFileSync(srcEntry, dstEntry);
    else if (entry.name.startsWith(".")) continue;
    else if (entry.name.startsWith("@") && entry.isDirectory()) {
      fs.mkdirSync(dstEntry);
      for (const scoped of fs.readdirSync(srcEntry)) linkEntry(path.join(srcEntry, scoped), path.join(dstEntry, scoped), scope);
    } else linkEntry(srcEntry, dstEntry, scope);
  }
  return counts;
}

function removeExisting(modules: string, sourceModules: string, worktree: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(modules);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw new WorktreeSetupError("remove old node_modules", worktree, `cannot stat ${modules}: ${String(error instanceof Error ? error.message : error)}`);
  }
  // A symlinked node_modules is unlinked, never recursed into: its target is the source's install.
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(modules);
    return;
  }
  if (fs.realpathSync(modules) === sourceModules) {
    throw new WorktreeSetupError("remove old node_modules", worktree, `${modules} is the source's node_modules itself; refusing to replace it`);
  }
  fs.rmSync(modules, { recursive: true, force: true });
}

// The gitignored records the doc gate scans and its verify commands name relative to the checkout.
// A worktree has none of them, so each outermost scanned path is linked to the main checkout's copy.
// The scope module is loaded by a computed specifier because plain node needs its .ts name, which
// the typechecker refuses in a static import.
async function recordLinks(worktree: string): Promise<readonly string[]> {
  const scopeModule = new URL("./check-docs-scope.ts", import.meta.url);
  const loaded: unknown = await import(scopeModule.href);
  const sources = typeof loaded === "object" && loaded !== null && "SCAN_SOURCES" in loaded ? loaded.SCAN_SOURCES : undefined;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new WorktreeSetupError("record links", worktree, `${fileURLToPath(scopeModule)} exports no non-empty SCAN_SOURCES`);
  }
  const rels = sources.map((source: unknown) => {
    if (typeof source === "object" && source !== null && "rel" in source && typeof source.rel === "string" && source.rel !== "") return source.rel;
    throw new WorktreeSetupError("record links", worktree, `${fileURLToPath(scopeModule)} has a SCAN_SOURCES entry without a rel path: ${JSON.stringify(source)}`);
  });
  return rels.filter((rel) => !rels.some((outer) => outer !== rel && rel.startsWith(`${outer}${path.sep}`)));
}

interface RecordLink {
  readonly rel: string;
  readonly action: "create" | "present" | "absent";
  readonly target: string;
}

function realpathOrUndefined(file: string): string | undefined {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function planRecordLink(rel: string, worktree: string, mainCheckout: string): RecordLink {
  const target = path.join(mainCheckout, rel);
  const mainRecord = realpathOrUndefined(target);
  if (mainRecord === undefined) return { rel, action: "absent", target };
  const own = path.join(worktree, rel);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(own);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { rel, action: "create", target: mainRecord };
    throw new WorktreeSetupError(`${rel} link`, worktree, `cannot stat ${own}: ${String(error instanceof Error ? error.message : error)}`);
  }
  if (realpathOrUndefined(own) === mainRecord) return { rel, action: "present", target: mainRecord };
  const what = stat.isSymbolicLink() ? `a symlink to ${fs.readlinkSync(own)}` : stat.isDirectory() ? "a directory" : "a file";
  throw new WorktreeSetupError(`${rel} link`, worktree, `${own} is ${what}, not a link to ${mainRecord}; move it aside so ${rel} can be linked to the main checkout's records`);
}

function createRecordLink(link: RecordLink, worktree: string): void {
  if (link.action !== "create") return;
  const own = path.join(worktree, link.rel);
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.symlinkSync(link.target, own);
}

function describeRecordLinks(links: readonly RecordLink[]): string {
  return links.map((link) => (link.action === "absent" ? `no ${link.rel} link (${link.target} does not exist)` : `${link.rel} linked to ${link.target}`)).join("; ");
}

function setup(cli: Cli, recordRels: readonly string[]): void {
  const started = performance.now();
  const worktree = realDirectory(cli.dir, "worktree", cli.dir);
  if (!fs.existsSync(path.join(worktree, "package.json"))) {
    throw new WorktreeSetupError("worktree", worktree, "has no package.json, so it is not a checkout of this repository");
  }
  const source = cli.source === undefined ? mainCheckoutOf(worktree) : realDirectory(cli.source, "source", worktree);
  if (source === worktree) {
    throw new WorktreeSetupError("source", worktree, "is the source checkout itself; its node_modules comes from npm ci, not from this script");
  }
  const sourceModulesPath = path.join(source, "node_modules");
  if (!fs.existsSync(sourceModulesPath) || !fs.lstatSync(sourceModulesPath).isDirectory()) {
    throw new WorktreeSetupError("source node_modules", worktree, `${sourceModulesPath} is missing or not a directory; run npm ci in ${source} (or npm ci in ${worktree})`);
  }
  const sourceModules = fs.realpathSync(sourceModulesPath);
  const sourceLock = readLockfile(source, worktree);
  const lockDiff = lockedPackageDiff(sourceLock, source, readLockfile(worktree, worktree), worktree);
  if (lockDiff.length > 0) {
    const shown = lockDiff.slice(0, 5).join(", ");
    const more = lockDiff.length > 5 ? ` (and ${lockDiff.length - 5} more)` : "";
    throw new WorktreeSetupError("lockfile", worktree, `package-lock.json locks different packages than ${path.join(source, "package-lock.json")} (${shown}${more}), so the source's installed packages are not this worktree's; run npm ci in ${worktree}`);
  }
  checkInstall(source, sourceModules, sourceLock, worktree);
  const recordsCheckout = cli.source === undefined ? source : mainCheckoutOf(worktree);
  const records = recordRels.map((rel) => planRecordLink(rel, worktree, recordsCheckout));

  const modules = path.join(worktree, "node_modules");
  const staging = path.join(worktree, `node_modules.worktree-setup-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging);
  let counts: LinkCounts;
  try {
    counts = populate(staging, source, sourceModules, worktree);
    removeExisting(modules, sourceModules, worktree);
    fs.renameSync(staging, modules);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  for (const link of records) createRecordLink(link, worktree);
  const seconds = ((performance.now() - started) / 1000).toFixed(2);
  console.log(`worktree-setup: ${modules} links ${counts.external} external package(s) and ${counts.bin} bin(s) from ${sourceModules}, and ${counts.workspace} workspace package(s) to ${worktree}; ${describeRecordLinks(records)}; in ${seconds}s`);
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const cli = parseCli(argv);
    setup(cli, await recordLinks(path.resolve(cli.dir)));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}

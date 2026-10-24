import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { SCAN_SOURCES } from "./check-docs-scope.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO, "scripts", "worktree-setup.ts");

// The outermost paths the doc gate scans: what worktree-setup links.
const RECORD_RELS = SCAN_SOURCES.map((source) => source.rel).filter(
  (rel, _index, rels) => !rels.some((outer) => outer !== rel && rel.startsWith(`${outer}${path.sep}`)),
);

const RootManifest = z.object({ workspaces: z.array(z.string()).nonempty() });
const PackageManifest = z.object({ name: z.string().min(1) });
const LockFile = z.looseObject({ packages: z.record(z.string(), z.record(z.string(), z.unknown())) });

let tmp = "";
let worktree = "";
let mainCheckout = "";

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], cwd: string): Run {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 240_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function setup(...args: string[]): Run {
  return run(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT, ...args], REPO);
}

// This checkout's install is the only one the tests rely on: the fixture main checkout links it, and
// the linking tests take it as the source; the lockfile refusal test keeps the default source, the
// fixture main checkout.
function setupFromRepo(dir: string): Run {
  return setup(dir, "--source", REPO);
}

// Enumerated from the root manifest's workspaces globs, independently of the script, which reads
// the main checkout's node_modules instead.
function workspacePackages(checkout: string): { name: string; dir: string }[] {
  const { workspaces } = RootManifest.parse(JSON.parse(fs.readFileSync(path.join(checkout, "package.json"), "utf8")));
  const dirs = workspaces.flatMap((glob) => {
    if (!glob.endsWith("/*")) return [glob];
    const parent = glob.slice(0, -2);
    return fs
      .readdirSync(path.join(checkout, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(checkout, parent, entry.name, "package.json")))
      .map((entry) => path.join(parent, entry.name));
  });
  return dirs.map((dir) => ({ name: PackageManifest.parse(JSON.parse(fs.readFileSync(path.join(checkout, dir, "package.json"), "utf8"))).name, dir }));
}

function workspaceRealpaths(checkout: string): Record<string, string> {
  return Object.fromEntries(workspacePackages(checkout).map(({ name }) => [name, fs.realpathSync(path.join(checkout, "node_modules", name))]));
}

function linkSnapshot(modules: string): string[] {
  const entries: string[] = [];
  for (const name of fs.readdirSync(modules).sort()) {
    const full = path.join(modules, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) entries.push(`${name} -> ${fs.readlinkSync(full)}`);
    else if (stat.isDirectory()) entries.push(...linkSnapshot(full).map((child) => `${name}/${child}`));
    else entries.push(`${name} (file)`);
  }
  return entries;
}

// A record symlink is unlinked, never recursed into: its target is the main checkout's records.
function removeRecord(record: string): void {
  if (!fs.existsSync(record) && !isSymlink(record)) return;
  if (isSymlink(record)) fs.unlinkSync(record);
  else fs.rmSync(record, { recursive: true });
}

function removeRecordLinks(): void {
  for (const rel of RECORD_RELS) removeRecord(path.join(worktree, rel));
}

function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): void {
  const result = run("git", args, cwd);
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
}

// The records are gitignored, so a checkout of this repository may have none (CI never does): the
// tests own a main checkout of HEAD holding fixture records, and the worktree under test is its.
function writeFixtureRecords(checkout: string): void {
  for (const { rel, kind } of SCAN_SOURCES.filter((source) => RECORD_RELS.includes(source.rel))) {
    const file = kind === "file" ? path.join(checkout, rel) : path.join(checkout, rel, "fixture.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture ${rel}\n`);
  }
}

// The manifests this checkout's install was made from, in its working tree: committed or not, they
// are what the source's lockfile is compared with, so the fixture checkout holds the same ones.
function liveManifests(): string[] {
  const workspaces = workspacePackages(REPO).map(({ dir }) => path.join(dir, "package.json"));
  return ["package.json", "package-lock.json", ...workspaces];
}

function commitLiveManifests(checkout: string): void {
  const manifests = liveManifests();
  for (const rel of manifests) {
    fs.mkdirSync(path.dirname(path.join(checkout, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(checkout, rel));
  }
  git(checkout, "add", "--", ...manifests);
  const identity = ["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
  git(checkout, ...identity, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", "the source checkout's manifests");
}

beforeAll(() => {
  tmp =fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ashara-worktree-setup-")));
  mainCheckout = path.join(tmp, "main");
  worktree = path.join(tmp, "wt");
  git(tmp, "init", "--quiet", mainCheckout);
  git(mainCheckout, "fetch", "--quiet", "--depth=1", REPO, "HEAD");
  git(mainCheckout, "checkout", "--quiet", "--detach", "FETCH_HEAD");
  commitLiveManifests(mainCheckout);
  writeFixtureRecords(mainCheckout);
  const install = setupFromRepo(mainCheckout);
  expect(install.status, install.stderr).toBe(0);
  git(mainCheckout, "worktree", "add", "--quiet", "--detach", worktree, "HEAD");
});

afterAll(() => {
  if (tmp !== "") fs.rmSync(tmp, { recursive: true, force: true });
});

describe("worktree-setup", () => {
  test("the fixture checkouts hold the manifests and lockfile of this checkout's working tree, so the source's lockfile is compared like with like", () => {
    for (const rel of liveManifests()) {
      const live = fs.readFileSync(path.join(REPO, rel));
      expect(fs.readFileSync(path.join(mainCheckout, rel)).equals(live), `${rel} in the fixture main checkout`).toBe(true);
      expect(fs.readFileSync(path.join(worktree, rel)).equals(live), `${rel} in the fixture worktree`).toBe(true);
    }
  });

  test("links a fresh worktree so typecheck runs and every workspace package resolves into the worktree, idempotently, leaving the main checkout untouched", () => {
    const mainBefore = workspaceRealpaths(mainCheckout);
    const mainLinksBefore = linkSnapshot(path.join(mainCheckout, "node_modules"));
    const sourceBefore = workspaceRealpaths(REPO);
    const sourceLinksBefore = linkSnapshot(path.join(REPO, "node_modules"));

    const first = setupFromRepo(worktree);
    expect(first.status, first.stderr).toBe(0);

    const packages = workspacePackages(worktree);
    expect(packages.map(({ name }) => name)).toContain("@ashara/shared");
    for (const { name, dir } of packages) {
      expect(fs.realpathSync(path.join(worktree, "node_modules", name)), name).toBe(path.join(worktree, dir));
    }
    expect(fs.realpathSync(path.join(worktree, "node_modules", "@ashara", "shared")).startsWith(path.join(worktree, "packages") + path.sep)).toBe(true);

    const resolved = run(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('@ashara/shared'))"], worktree);
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(fs.realpathSync(fileURLToPath(resolved.stdout.trim())).startsWith(path.join(worktree, "packages", "shared") + path.sep)).toBe(true);

    const typecheck = run("npm", ["run", "--silent", "typecheck"], worktree);
    expect(typecheck.status, `${typecheck.stdout}\n${typecheck.stderr}`).toBe(0);

    const linksAfterFirst = linkSnapshot(path.join(worktree, "node_modules"));
    const second = setupFromRepo(worktree);
    expect(second.status, second.stderr).toBe(0);
    expect(linkSnapshot(path.join(worktree, "node_modules"))).toEqual(linksAfterFirst);

    expect(workspaceRealpaths(mainCheckout)).toEqual(mainBefore);
    expect(linkSnapshot(path.join(mainCheckout, "node_modules"))).toEqual(mainLinksBefore);
    expect(workspaceRealpaths(REPO)).toEqual(sourceBefore);
    expect(linkSnapshot(path.join(REPO, "node_modules"))).toEqual(sourceLinksBefore);
  });

  test("links every record the doc gate scans to the main checkout's copy, idempotently", () => {
    const scanned = SCAN_SOURCES.map((source) => source.rel).filter((rel) => fs.existsSync(path.join(mainCheckout, rel)));
    expect(RECORD_RELS).toContain("docs");
    expect(scanned, "the main checkout has every record the doc gate scans to link").toEqual(expect.arrayContaining(RECORD_RELS));
    removeRecordLinks();

    const first = setupFromRepo(worktree);
    expect(first.status, first.stderr).toBe(0);
    expect(fs.lstatSync(path.join(worktree, "docs")).isSymbolicLink()).toBe(true);
    for (const rel of scanned) {
      expect(fs.realpathSync(path.join(worktree, rel)), rel).toBe(fs.realpathSync(path.join(mainCheckout, rel)));
    }
    const targets = scanned.map((rel) => fs.realpathSync(path.join(worktree, rel)));
    const status = run("git", ["status", "--porcelain", "--untracked-files=all"], worktree);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout, "the record links are ignored, so git add -A in a worktree never commits them").toBe("");

    const second = setupFromRepo(worktree);
    expect(second.status, second.stderr).toBe(0);
    expect(fs.lstatSync(path.join(worktree, "docs")).isSymbolicLink()).toBe(true);
    expect(scanned.map((rel) => fs.realpathSync(path.join(worktree, rel)))).toEqual(targets);
  });

  test("refuses with WorktreeSetupError and leaves a pre-existing docs directory that is not the link untouched", () => {
    removeRecordLinks();
    const docs = path.join(worktree, "docs");
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, "own.md"), "own\n");
    try {
      const refused = setupFromRepo(worktree);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("WorktreeSetupError: docs link failed");
      expect(fs.lstatSync(docs).isDirectory()).toBe(true);
      expect(fs.readdirSync(docs)).toEqual(["own.md"]);
      expect(fs.readFileSync(path.join(docs, "own.md"), "utf8")).toBe("own\n");
      for (const rel of RECORD_RELS.filter((other) => other !== "docs")) {
        expect(fs.existsSync(path.join(worktree, rel)), `${rel}: nothing is linked once a record is refused`).toBe(false);
      }
    } finally {
      removeRecord(docs);
    }
  });

  test("refuses with WorktreeSetupError naming the package and npm ci when the lockfiles lock a package differently", () => {
    const lockfile = path.join(worktree, "package-lock.json");
    const original = fs.readFileSync(lockfile);
    try {
      const lock = LockFile.parse(JSON.parse(original.toString("utf8")));
      const key = Object.keys(lock.packages).find((name) => name.startsWith("node_modules/"));
      if (key === undefined) throw new TypeError(`${lockfile} locks no node_modules package`);
      lock.packages[key] = { ...lock.packages[key], version: "0.0.0-drifted" };
      fs.writeFileSync(lockfile, JSON.stringify(lock, null, 2));
      const refused = setup(worktree);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("WorktreeSetupError");
      expect(refused.stderr).toContain(key);
      expect(refused.stderr).toContain("npm ci");
    } finally {
      fs.writeFileSync(lockfile, original);
    }
  });

  test("accepts lockfiles that differ only in the root project's own entry and formatting", () => {
    const lockfile = path.join(worktree, "package-lock.json");
    const original = fs.readFileSync(lockfile);
    try {
      const lock = LockFile.parse(JSON.parse(original.toString("utf8")));
      lock.packages[""] = { ...lock.packages[""], engines: { node: ">=0.0.1-root-only" } };
      fs.writeFileSync(lockfile, JSON.stringify(lock));
      const accepted = setupFromRepo(worktree);
      expect(accepted.status, accepted.stderr).toBe(0);
    } finally {
      fs.writeFileSync(lockfile, original);
    }
  });

  test("refuses with the install drift error naming npm ci in the source when the source's installed tree differs from its own lockfile, creating no node_modules", () => {
    const source = path.join(tmp, "drifted-source");
    const target = path.join(tmp, "drift-target");
    fs.mkdirSync(path.join(source, "node_modules"), { recursive: true });
    fs.mkdirSync(target);
    const lockText = fs.readFileSync(path.join(mainCheckout, "package-lock.json"), "utf8");
    for (const dir of [source, target]) {
      fs.writeFileSync(path.join(dir, "package-lock.json"), lockText);
      fs.copyFileSync(path.join(mainCheckout, "package.json"), path.join(dir, "package.json"));
    }
    const LockPackages = z.object({ packages: z.record(z.string(), z.object({ version: z.string().optional(), optional: z.boolean().optional() }).passthrough()) });
    const { packages } = LockPackages.parse(JSON.parse(lockText));
    const installed = Object.fromEntries(Object.entries(packages).filter(([key, entry]) => key !== "" && entry.optional !== true));
    const bumped = Object.keys(installed).find((key) => key.startsWith("node_modules/") && installed[key]?.version !== undefined);
    expect(bumped).toBeDefined();
    installed[String(bumped)] = { ...installed[String(bumped)], version: "999.0.0" };
    fs.writeFileSync(path.join(source, "node_modules", ".package-lock.json"), JSON.stringify({ name: "ashara", lockfileVersion: 3, packages: installed }));

    const refused = setup(target, "--source", source);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("WorktreeSetupError: install drift failed");
    expect(refused.stderr).toContain(`run npm ci in ${source}`);
    expect(refused.stderr).toContain(`${String(bumped)} version is 999.0.0 installed`);
    expect(fs.existsSync(path.join(target, "node_modules"))).toBe(false);
  });

  test("refuses with WorktreeSetupError and names npm ci when the source checkout has no node_modules", () => {
    const bare = path.join(tmp, "no-modules");
    fs.mkdirSync(bare);
    fs.copyFileSync(path.join(worktree, "package-lock.json"), path.join(bare, "package-lock.json"));
    const refused = setup(worktree, "--source", bare);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("WorktreeSetupError");
    expect(refused.stderr).toContain("npm ci");
  });
});

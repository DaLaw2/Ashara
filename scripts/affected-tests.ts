/**
 * Affected-test selection: lists the test files a change can affect and runs exactly those.
 *
 * Usage: npx tsx scripts/affected-tests.ts <base> [--head <rev>] [--cap <n>] [--list] [-- <vitest run args>]
 *
 * The change is every file that differs between the merge base of <base> and HEAD and the working
 * tree, untracked files included; with --head, between that merge base and <rev>, the working tree
 * not read. --list prints the selection and runs nothing. Otherwise the selection runs as one
 * `vitest run` and this script exits with its exit code. The repo root is the working directory.
 *
 * Bound: a selection (the whole suite included) of more test files than the cap (--cap, default
 * DEFAULT_SELECTION_CONFIG) runs only the direct tests of the changed files: a changed test file, the
 * test file a changed snapshot belongs to, the colocated `<name>.test.ts` of a changed module, and
 * the test files whose own import edges may load a changed module (an import() or require() whose
 * target no literal spells counts by its template prefix, or else by its workspace). One line says the
 * selection exceeds the cap and how many files were skipped, or that none was; the merge lane's
 * full suite runs the skipped ones. The cap never
 * trims what a dependency or toolchain change selects: those tests run whatever their number, and
 * so does the whole suite a dependency change or a whole-suite rule that is not capped selects. A
 * selection that comes to no test file for a change that touches source fails the run instead of
 * passing it; only a change every path of which a no-test-effect rule clears (or a deleted test
 * file) runs nothing and exits 0.
 *
 * Mechanism: vitest's module graph (the test specifications `vitest related` would run). A test is
 * selected when it imports a changed module through any chain of static imports, or of dynamic
 * imports whose specifier is a literal. On top of the graph, rules for what the graph cannot see,
 * applied to each changed path in this order, the first that decides a path ending it:
 * - Dependencies: the root manifest, and a manifest outside the workspaces the lockfile records,
 *   select the whole suite. A workspace's manifest selects that workspace and every workspace that
 *   resolves it (lockfile-impact.ts); package-lock.json selects every workspace that resolves a
 *   changed entry, or the whole suite when the change cannot be attributed to a workspace (an entry
 *   the root project resolves among them). A selected workspace brings every test under it, the
 *   graph dependants of every module under it, and the graph dependants of every module or test
 *   that imports its package, or the outermost package a changed entry sits under (a changed
 *   workspace entry: that workspace's package), by name: the import edges are read from each
 *   file's syntax tree (import-targets.ts), never from its text, so a comment or a string that
 *   spells a specifier is no edge. A literal specifier names the package whole; a template-literal
 *   one names it by its static prefix. An import() or require() whose target no static prefix
 *   bounds, or a file whose text cannot be read, brings every module and test of its workspace
 *   (the deepest enclosing directory with a package.json, or the root project's files outside
 *   them). The reasons name every file each of these adds.
 * - Whole suite (WHOLE_SUITE_RULES): a file that changes how every test is collected, compiled,
 *   resolved or run, or that every database test reads at runtime. Any one such file selects the
 *   whole suite, each with the reason the table states.
 * - A deleted or renamed module selects the whole suite: the graph is built from the files that
 *   exist, so the importers of a module that no longer exists are not in it.
 * - A changed test file selects itself; a changed snapshot selects the test file it belongs to.
 * - A module under the simulator (SIMULATOR_DIR) selects every simulator test: a simulator change
 *   moves the seeded fault and persona draws every scenario consumes, which no import edge records.
 * - Every changed file also selects the test files that spell its file name, which catches a test
 *   that reads the file at runtime or runs it in a child process (a script spawned by path).
 * - A changed file that is not a module the graph reads (SQL, TOML, CSS, ...) feeds into the graph
 *   every module that spells its name; when no module and no test spells it, and no rule in
 *   NO_TEST_EFFECT_RULES clears it, it selects the whole suite: nothing bounds its effect.
 *
 * Blind spots, each a change this selection under-runs (the merge lane's full suite and soak run
 * every test and are the only net for them):
 * - Dynamic imports whose specifier is computed, and modules loaded by a path built at runtime
 *   (a directory listing, a glob, a path joined from parts no single literal spells), for a change
 *   to a module; for a dependency change the rule above brings the importer's whole workspace.
 * - Files read at runtime by a module whose name the module never spells whole: a SQL file found by
 *   listing migrations/, a TOML file located through a configured directory, a fixture tree copied
 *   by walking it. Migrations themselves select the whole suite; every other such file does not.
 * - Tests that read source text at runtime to judge it (the boundary lint's probes, the stack-literal
 *   scan, the optional-deps scan) see every module, but only the ones whose name they spell select
 *   them; `just check` runs those scans on the whole tree.
 * - Cross-process and cross-test effects: the simulator's fault schedule and seed draws as the soak
 *   runs them, state a test leaves in the shared database or in podman, timing and interleaving
 *   between test files. Only the merge lane's soak and full suite exercise these.
 * - Type-only imports are erased before the graph is built: a change that only alters types selects
 *   nothing through them, and `just check`'s typecheck is what judges it.
 * - The modules globalSetup imports (vitest.config.mts) run in every test run; only the setup file
 *   itself is a whole-suite rule, its own imports reach just the tests that import them.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeErrorChain } from "@ashara/shared";
import { importTargets, type ImportTarget } from "./import-targets.js";
import { lockfileImpact, manifestImpact, parseLockfile, type DependencyImpact, type Lockfile } from "./lockfile-impact.js";

class AffectedTestsError extends Error {
  constructor(
    readonly subject: string,
    readonly reason: string,
  ) {
    super(`affected-tests: ${subject}: ${reason}`);
    this.name = "AffectedTestsError";
  }
}

type ChangeStatus = "added" | "modified" | "deleted";

/**
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export interface ChangedPath {
  /** Repo-relative, forward slashes. */
  readonly path: string;
  readonly status: ChangeStatus;
}

interface PathRule {
  readonly pattern: RegExp;
  readonly reason: string;
}

interface WholeSuiteRule extends PathRule {
  /** Whether the cap may trim the whole suite this rule selects down to the direct tests. */
  readonly capped: boolean;
}

/**
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export const WHOLE_SUITE_RULES: readonly WholeSuiteRule[] = [
  { pattern: /^migrations\//, capped: true, reason: "every database test runs on the migrated schema, and no test imports a migration" },
  { pattern: /^boundary-rules\.toml$/, capped: true, reason: "the boundary lint and the stack-literal scan read it at runtime, and their tests judge the whole tree against it" },
  { pattern: /^eslint\.config\.mjs$/, capped: true, reason: "the ESLint guard tests lint with it at runtime" },
  { pattern: /(^|\/)tsconfig[^/]*\.json$/, capped: true, reason: "it changes how every module compiles and resolves" },
  { pattern: /^vitest\.config\.[cm]?[jt]s$/, capped: false, reason: "it changes which files are tests and how every test runs" },
  { pattern: /^packages\/integration\/src\/cell-leak-guard\.ts$/, capped: true, reason: "vitest.config.mts runs it as globalSetup around every test run" },
  {
    pattern: /^packages\/integration\/src\/podman-test-load\.ts$/,
    capped: true,
    reason: "vitest.config.mts reads it for which files are podman tests, how many run at once and their timeouts, and the globalSetup guards for their podman bound",
  },
  { pattern: /^config\//, capped: true, reason: "the runtime configuration the composition root and the test harness read by a configured path" },
];

const LOCKFILE = "package-lock.json";
const ROOT_MANIFEST = "package.json";
const MANIFEST_RE = /(^|\/)package(-lock)?\.json$/;

const NO_TEST_EFFECT_RULES: readonly PathRule[] = [
  { pattern: /^README\.md$/, reason: "prose no test or module reads" },
  { pattern: /^\.gitignore$/, reason: "git's ignore list; no test reads it" },
  { pattern: /^\.github\//, reason: "the CI workflow, which runs the suite and is not run by it" },
  { pattern: /^knip\.json$/, reason: "read by knip in `just check`, never by a test" },
];

/**
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export const SIMULATOR_DIR = "packages/integration/src/simulator/";

const TEST_FILE_RE = /\.test\.ts$/;
const SNAPSHOT_RE = /^(.*)\/__snapshots__\/([^/]+\.test\.ts)\.snap$/;
/** The files vitest's graph reads: the modules tests import, in the trees vitest.config.mts includes. */
const GRAPH_MODULE_RE = /^(packages\/[^/]+\/src|scripts)\/.+\.(ts|mjs|js)$/;

interface SelectionBasis {
  /** The direct tests of the changed files (see the bound in the header), repo-relative, sorted. */
  readonly direct: readonly string[];
  /** Whether any changed path is one whose change must be judged by a test. */
  readonly touchesSource: boolean;
}

type Selection = SelectionBasis &
  (
    | {
        readonly kind: "whole-suite";
        readonly reasons: readonly string[];
        /** Whether the cap may trim it; a dependency or toolchain change's whole suite runs whole. */
        readonly capped: boolean;
        /** The tests a dependency change in the same change selects, which the cap keeps, repo-relative, sorted. */
        readonly required: readonly string[];
      }
    | {
        readonly kind: "selected";
        /** Repo-relative test files, sorted. */
        readonly tests: readonly string[];
        /** The tests a dependency change selects, which the cap keeps, repo-relative, sorted. */
        readonly required: readonly string[];
        /** Per changed path, why it selected what it did. */
        readonly reasons: readonly string[];
      }
  );

/**
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export interface SelectionConfig {
  /** The most test files a selection runs before it falls back to the direct tests. */
  readonly maxTests: number;
}

/**
 * About a fifth of the suite: a share an implementer's run finishes well inside the outer wall cap
 * the justfile recipe sets, with podman suites among it.
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export const DEFAULT_SELECTION_CONFIG: SelectionConfig = { maxTests: 40 };

/**
 * What selection needs from the repository: the test list, the module graph and a name search.
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export interface SelectionSources {
  /** Every test file vitest.config.mts includes, repo-relative. */
  readonly allTests: readonly string[];
  /** Every tracked or untracked file of the working tree, repo-relative. */
  readonly files: readonly string[];
  /** A file's text at the merge base or at the head of the change; undefined where it does not exist. */
  readonly readRevision: (file: string, side: "base" | "head") => string | undefined;
  /** The test files that import any of these modules through the graph, repo-relative. */
  readonly testsImporting: (modules: readonly string[]) => Promise<readonly string[]>;
  /** The tracked or untracked files whose text contains `name`, repo-relative. */
  readonly filesNaming: (name: string) => readonly string[];
  /** The test files whose own import edges resolve to any of these modules (depth 1), repo-relative. */
  readonly testsImportingDirectly: (modules: readonly string[]) => Promise<readonly string[]>;
}

/**
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export async function selectTests(changes: readonly ChangedPath[], sources: SelectionSources): Promise<Selection> {
  if (changes.length === 0) throw new AffectedTestsError("change", "no file differs from the base: there is no change to select tests for");
  const wholeSuite: string[] = [];
  const reasons: string[] = [];
  const tests = new Set<string>();
  const graphModules = new Set<string>();
  const changedModules = new Set<string>();
  const direct = new Set<string>();
  let touchesSource = false;
  let uncappedWholeSuite = false;
  const allTests = new Set(sources.allTests);
  const impacts: DependencyImpact[] = [];
  let lockfiles: LockfileRevisions | undefined;
  const readLockfiles = (): LockfileRevisions => (lockfiles ??= { base: readLockfile(sources, "base"), head: readLockfile(sources, "head") });

  for (const change of changes) {
    const file = change.path;
    const isDeletedTest = change.status === "deleted" && TEST_FILE_RE.test(file);
    if (!isDeletedTest && !NO_TEST_EFFECT_RULES.some((r) => r.pattern.test(file))) touchesSource = true;
    if (!TEST_FILE_RE.test(file) && GRAPH_MODULE_RE.test(file)) {
      const colocated = file.replace(/\.(ts|mjs|js)$/, ".test.ts");
      if (allTests.has(colocated)) direct.add(colocated);
      if (change.status !== "deleted") changedModules.add(file);
    }
    if (MANIFEST_RE.test(file)) {
      const impact = dependencyImpact(file, readLockfiles());
      if (impact.kind === "whole-suite") {
        wholeSuite.push(`${file}: ${impact.reason}`);
        uncappedWholeSuite = true;
      } else {
        impacts.push(impact);
        const names = impact.packageNames.length > 0 ? `, and of every module that imports ${impact.packageNames.join(", ")} by name (listed below)` : "";
        reasons.push(`${file}: ${impact.reason}; selects every test of ${impact.workspaces.length} workspace(s) (${impact.workspaces.join(", ")}) and the graph dependants of their modules${names}, past the cap`);
      }
      continue;
    }
    const rule = WHOLE_SUITE_RULES.find((r) => r.pattern.test(file));
    if (rule !== undefined) {
      wholeSuite.push(`${file}: ${rule.reason}`);
      if (!rule.capped) uncappedWholeSuite = true;
      continue;
    }
    const namers = sources.filesNaming(path.posix.basename(file)).filter((f) => f !== file);
    const namingTests = namers.filter((f) => allTests.has(f));
    for (const t of namingTests) tests.add(t);
    const named = namingTests.length > 0 ? `; named by ${namingTests.length} test file(s)` : "";

    if (change.status === "deleted" && !TEST_FILE_RE.test(file) && GRAPH_MODULE_RE.test(file)) {
      wholeSuite.push(`${file}: deleted, and the graph cannot see the importers of a module that no longer exists`);
      continue;
    }
    if (TEST_FILE_RE.test(file)) {
      if (change.status !== "deleted") {
        tests.add(file);
        direct.add(file);
      }
      reasons.push(`${file}: test file${change.status === "deleted" ? " deleted, selects nothing" : ", selects itself"}${named}`);
      continue;
    }
    const snapshot = SNAPSHOT_RE.exec(file);
    if (snapshot !== null) {
      const owner = `${snapshot[1]}/${snapshot[2]}`;
      if (allTests.has(owner)) {
        tests.add(owner);
        direct.add(owner);
      }
      reasons.push(`${file}: snapshot of ${owner}`);
      continue;
    }
    if (GRAPH_MODULE_RE.test(file)) {
      graphModules.add(file);
      if (file.startsWith(SIMULATOR_DIR)) {
        const simulatorTests = sources.allTests.filter((t) => t.startsWith(SIMULATOR_DIR));
        for (const t of simulatorTests) tests.add(t);
        reasons.push(`${file}: simulator module, selects all ${simulatorTests.length} simulator test files and its graph dependants${named}`);
      } else {
        reasons.push(`${file}: module, selects its graph dependants${named}`);
      }
      continue;
    }
    const clear = NO_TEST_EFFECT_RULES.find((r) => r.pattern.test(file));
    if (clear !== undefined) {
      reasons.push(`${file}: selects nothing, ${clear.reason}`);
      continue;
    }
    const namingModules = namers.filter((f) => GRAPH_MODULE_RE.test(f) && !allTests.has(f));
    if (namingModules.length === 0 && namingTests.length === 0) {
      wholeSuite.push(`${file}: no rule classifies it and no module or test names it, so nothing bounds its effect`);
      continue;
    }
    for (const m of namingModules) graphModules.add(m);
    reasons.push(`${file}: read at runtime; selects the dependants of the ${namingModules.length} module(s) that name it${named}`);
  }

  if (changedModules.size > 0) for (const t of await sources.testsImportingDirectly([...changedModules])) direct.add(t);
  const basis: SelectionBasis = { direct: [...direct].sort(), touchesSource };
  if (wholeSuite.length > 0 && uncappedWholeSuite) return { ...basis, kind: "whole-suite", reasons: wholeSuite, capped: false, required: [] };
  const dependency = await dependencyTests(impacts, sources);
  const required = dependency.tests;
  reasons.push(...dependency.reasons);
  if (wholeSuite.length > 0) return { ...basis, kind: "whole-suite", reasons: [...wholeSuite, ...reasons], capped: true, required };
  if (graphModules.size > 0) for (const t of await sources.testsImporting([...graphModules])) tests.add(t);
  for (const t of required) tests.add(t);
  return { ...basis, kind: "selected", tests: [...tests].sort(), required, reasons };
}

interface LockfileRevisions {
  readonly base: Lockfile | undefined;
  readonly head: Lockfile | undefined;
}

function readLockfile(sources: SelectionSources, side: "base" | "head"): Lockfile | undefined {
  const text = sources.readRevision(LOCKFILE, side);
  return text === undefined ? undefined : parseLockfile(text, `${LOCKFILE} at the ${side}`);
}

function dependencyImpact(file: string, lockfiles: LockfileRevisions): DependencyImpact {
  if (file === LOCKFILE) return lockfileImpact(lockfiles.base, lockfiles.head);
  if (file === ROOT_MANIFEST) return { kind: "whole-suite", reason: "the root manifest declares the toolchain every test runs under and the workspaces every import resolves through" };
  const workspace = /^(.+)\/package\.json$/.exec(file)?.[1];
  if (workspace === undefined) return { kind: "whole-suite", reason: "a lockfile other than the root's, which no workspace attribution reads" };
  return manifestImpact(workspace, lockfiles.base, lockfiles.head);
}

/**
 * What a template-literal specifier's static prefix bounds: a built-in or a relative module loads no
 * package; an empty, absolute, URL or node_modules prefix may load anything; a bare one loads a
 * package whose name it begins.
 */
function templateTarget(prefix: string): "no-package" | "unbounded" | "package" {
  if (prefix.startsWith("node:")) return "no-package";
  if (prefix.includes("node_modules/")) return "unbounded";
  if (prefix.startsWith(".")) return "no-package";
  if (prefix === "" || prefix.startsWith("/") || prefix.includes(":")) return "unbounded";
  return "package";
}

function prefixMayName(prefix: string, name: string): boolean {
  return `${name}/`.startsWith(prefix) || prefix.startsWith(`${name}/`);
}

function specifierNames(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

/**
 * The workspace directory a file belongs to: the deepest enclosing directory with a package.json,
 * or the root project ("") when none encloses it.
 */
function owningWorkspace(file: string, manifestDirs: readonly string[]): string {
  return manifestDirs.filter((dir) => file.startsWith(`${dir}/`)).reduce((deepest, dir) => (dir.length > deepest.length ? dir : deepest), "");
}

function manifestDirsOf(files: readonly string[]): string[] {
  return files.flatMap((f) => (f !== ROOT_MANIFEST && f.endsWith("/package.json") ? [f.slice(0, -"/package.json".length)] : []));
}

function workspaceLabel(workspace: string): string {
  return workspace === "" ? "the root project's files outside every workspace" : `workspace ${workspace}`;
}

interface DependencySelection {
  /** Repo-relative, sorted. */
  readonly tests: string[];
  /** One line per package its importers bring, and per file whose import target brings its workspace. */
  readonly reasons: string[];
}

/** Every test a dependency change reaches, and why; see the header's dependency rule. */
async function dependencyTests(impacts: readonly DependencyImpact[], sources: SelectionSources): Promise<DependencySelection> {
  const required = new Set<string>();
  const modules = new Set<string>();
  const reasons = new Set<string>();
  const allTests = new Set(sources.allTests);
  const take = (file: string): void => {
    if (allTests.has(file)) required.add(file);
    else if (GRAPH_MODULE_RE.test(file) && !TEST_FILE_RE.test(file)) modules.add(file);
  };
  const manifestDirs = manifestDirsOf(sources.files);
  const takeWorkspace = (workspace: string): void => {
    for (const file of sources.files) {
      if (workspace === "" ? owningWorkspace(file, manifestDirs) === "" : file.startsWith(`${workspace}/`)) take(file);
    }
  };
  const workspaceImpacts = impacts.filter((impact) => impact.kind === "workspaces");
  for (const impact of workspaceImpacts) for (const workspace of impact.workspaces) takeWorkspace(workspace);
  if (workspaceImpacts.length > 0) {
    const importers = new Map(workspaceImpacts.flatMap((impact) => impact.packageNames).map((name) => [name, new Set<string>()]));
    const takeOwningWorkspace = (file: string, why: string): void => {
      const workspace = owningWorkspace(file, manifestDirs);
      takeWorkspace(workspace);
      reasons.add(`${file}: ${why}, so every module and test of ${workspaceLabel(workspace)} runs, past the cap`);
    };
    for (const file of sources.files) {
      if (!allTests.has(file) && !GRAPH_MODULE_RE.test(file)) continue;
      const text = sources.readRevision(file, "head");
      if (text === undefined) {
        takeOwningWorkspace(file, "its text cannot be read to see what it imports");
        continue;
      }
      for (const target of importTargets(file, text)) {
        if (target.kind === "computed") {
          takeOwningWorkspace(file, "an import whose target is computed may load any package");
          continue;
        }
        if (target.kind === "template" && templateTarget(target.prefix) === "unbounded") {
          takeOwningWorkspace(file, `an import whose template target begins \`${target.prefix}\` may load any package`);
          continue;
        }
        for (const [name, files] of importers) {
          const named = target.kind === "static" ? specifierNames(target.specifier, name) : templateTarget(target.prefix) === "package" && prefixMayName(target.prefix, name);
          if (!named) continue;
          take(file);
          files.add(file);
        }
      }
    }
    for (const [name, files] of importers) {
      const which = files.size === 0 ? "" : ` (${[...files].sort().join(", ")})`;
      reasons.add(`${name}: ${files.size} module(s) and test(s) import it by name${which}; they and their graph dependants run, past the cap`);
    }
  }
  if (modules.size > 0) for (const t of await sources.testsImporting([...modules])) required.add(t);
  return { tests: [...required].sort(), reasons: [...reasons] };
}

/**
 * What a selection runs once the cap applies; `notice` is the line the run prints about it.
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export type BoundedRun =
  | { readonly kind: "whole-suite"; readonly count: number }
  | { readonly kind: "tests"; readonly tests: readonly string[]; readonly notice: string | undefined }
  | { readonly kind: "nothing"; readonly exitCode: 0 | 1; readonly notice: string };

/**
 * Applies the cap to a selection and judges an empty one: no test for a change that touches source
 * is a failed run, never a pass.
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export function boundSelection(selection: Selection, allTestCount: number, config: SelectionConfig): BoundedRun {
  if (!Number.isInteger(config.maxTests) || config.maxTests < 1) {
    throw new AffectedTestsError("cap", `${String(config.maxTests)} is not a positive whole number of test files`);
  }
  const count = selection.kind === "whole-suite" ? allTestCount : selection.tests.length;
  let tests: readonly string[];
  let notice: string | undefined;
  if (selection.kind === "whole-suite" && !selection.capped) {
    return { kind: "whole-suite", count };
  } else if (count > config.maxTests) {
    const required = selection.required;
    tests = [...new Set([...selection.direct, ...required])].sort();
    const kept = required.length === 0 ? "direct test file(s) of the changed files" : "direct test file(s) of the changed files and every test file of the changed dependencies";
    const skipped = count - tests.length;
    notice =
      skipped > 0
        ? `selection capped: ${count} test files exceed the cap of ${config.maxTests}; running the ${tests.length} ${kept}, ${skipped} skipped; the merge lane's full suite covers them`
        : `${count} test files exceed the cap of ${config.maxTests}; running the ${tests.length} ${kept}, which skips none of them`;
  } else if (selection.kind === "whole-suite") {
    return { kind: "whole-suite", count };
  } else {
    tests = selection.tests;
  }
  if (tests.length > 0) return { kind: "tests", tests, notice };
  const lead = notice === undefined ? "" : `${notice}. `;
  if (selection.touchesSource) {
    return { kind: "nothing", exitCode: 1, notice: `${lead}no test file is selected for a change that touches source; nothing runs, and that is a failed run, not a pass` };
  }
  return { kind: "nothing", exitCode: 0, notice: `${lead}no test file is affected by this change, which touches no source; nothing runs` };
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  if (result.error !== undefined) throw new AffectedTestsError(`git ${args.join(" ")}`, describeErrorChain(result.error));
  if (result.status !== 0) throw new AffectedTestsError(`git ${args.join(" ")}`, `exit ${String(result.status)}: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * Parses `git diff --name-status -z -M` output; a status it does not know fails the run.
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export function parseNameStatus(output: string): ChangedPath[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: ChangedPath[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i];
    const first = fields[i + 1];
    if (status === undefined || first === undefined) throw new AffectedTestsError("git diff --name-status", `truncated record at field ${i}`);
    const code = status.charAt(0);
    if (code === "R" || code === "C") {
      const second = fields[i + 2];
      if (second === undefined) throw new AffectedTestsError("git diff --name-status", `rename or copy without a target at field ${i}`);
      if (code === "R") changes.push({ path: first, status: "deleted" });
      changes.push({ path: second, status: "added" });
      i += 3;
      continue;
    }
    if (code === "A") changes.push({ path: first, status: "added" });
    else if (code === "D") changes.push({ path: first, status: "deleted" });
    else if (code === "M" || code === "T") changes.push({ path: first, status: "modified" });
    else throw new AffectedTestsError("git diff --name-status", `status "${status}" for ${first} is not one this script classifies`);
    i += 2;
  }
  return changes;
}

interface Change {
  /** The merge base the change is measured from. */
  readonly from: string;
  readonly paths: ChangedPath[];
}

function changedPaths(root: string, base: string, head: string | undefined): Change {
  const tip = head ?? "HEAD";
  git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  git(root, ["rev-parse", "--verify", "--quiet", `${tip}^{commit}`]);
  const from = git(root, ["merge-base", base, tip]).trim();
  const diffArgs = ["diff", "--name-status", "-z", "-M", "--no-ext-diff", from, ...(head === undefined ? [] : [head])];
  const changes = parseNameStatus(git(root, diffArgs));
  if (head === undefined) {
    for (const file of git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).split("\0")) {
      if (file !== "") changes.push({ path: file, status: "added" });
    }
  }
  return { from, paths: changes };
}

/**
 * The revisions selection reads files at: `base` the merge base, `head` the change's tip, or the
 * working tree when undefined.
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export interface Revisions {
  readonly base: string;
  readonly head: string | undefined;
}

function textAt(root: string, revision: string, file: string): string | undefined {
  if (git(root, ["ls-tree", "-z", "--name-only", revision, "--", file]) === "") return undefined;
  return git(root, ["show", `${revision}:${file}`]);
}

/**
 * The vitest-backed SelectionSources of the repository at `root`, closed by `close`.
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export async function repositorySources(root: string, revisions: Revisions): Promise<SelectionSources & { close: () => Promise<void> }> {
  // Imported where it is used: tsx runs this repo's scripts as CommonJS, and vitest/node is ESM only.
  const { createVitest } = await import("vitest/node");
  const vitest = await createVitest("test", { root, watch: false, run: true, reporters: [] });
  const relative = (abs: string): string => path.relative(root, abs).split(path.sep).join("/");
  const allTests = [...new Set((await vitest.globTestSpecifications()).map((s) => relative(s.moduleId)))].sort();
  const files = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter((f) => f !== "");
  const readRevision = (file: string, side: "base" | "head"): string | undefined => {
    if (side === "base") return textAt(root, revisions.base, file);
    if (revisions.head !== undefined) return textAt(root, revisions.head, file);
    const full = path.join(root, file);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf-8") : undefined;
  };
  const layout: WorkspaceLayout = { manifestDirs: manifestDirsOf(files), workspaceDirs: workspaceDirsOf(readRevision(LOCKFILE, "head")) };
  return {
    allTests,
    files,
    readRevision,
    testsImporting: async (modules) => {
      vitest.config.related = modules.map((m) => path.join(root, m));
      const specs = await vitest.getRelevantTestSpecifications();
      return [...new Set(specs.map((s) => relative(s.moduleId)))];
    },
    testsImportingDirectly: (modules) => Promise.resolve(testsImportingDirectly(allTests, modules, (file) => readRevision(file, "head"), layout)),
    filesNaming: (name) => {
      const result = spawnSync("git", ["grep", "-l", "-z", "-F", "--untracked", "-e", name], { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
      if (result.error !== undefined) throw new AffectedTestsError(`git grep ${name}`, describeErrorChain(result.error));
      // git grep exits 1 when nothing matches, which is an answer, not a failure.
      if (result.status === 1) return [];
      if (result.status !== 0) throw new AffectedTestsError(`git grep ${name}`, `exit ${String(result.status)}: ${result.stderr.trim()}`);
      return result.stdout.split("\0").filter((f) => f !== "");
    },
    close: () => vitest.close(),
  };
}

/** The repo-relative files a relative import specifier written in `importer` may resolve to. */
function specifierTargets(importer: string, specifier: string): string[] {
  if (!specifier.startsWith(".")) return [];
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const stem = joined.replace(/\.(js|mjs|ts)$/, "");
  return [joined, `${stem}.ts`, `${stem}.mjs`, `${stem}.js`, `${joined}/index.ts`];
}

/**
 * Where the repository's modules live, for an import edge whose target is not spelled whole.
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export interface WorkspaceLayout {
  /** Every directory with a package.json other than the root, repo-relative. */
  readonly manifestDirs: readonly string[];
  /** Each workspace's directory by its package name, or "unknown" when no lockfile records them. */
  readonly workspaceDirs: ReadonlyMap<string, string> | "unknown";
}

/**
 * The workspaces of the head lockfile, by package name: its entries under no node_modules segment.
 * No lockfile at the head leaves them unknown, so a template target that names a package may name any.
 */
function workspaceDirsOf(text: string | undefined): WorkspaceLayout["workspaceDirs"] {
  if (text === undefined) return "unknown";
  const lock = parseLockfile(text, `${LOCKFILE} at the head`);
  const dirs = new Map<string, string>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "" || key.split("/").includes("node_modules") || entry.name === undefined) continue;
    dirs.set(entry.name, key);
  }
  return dirs;
}

/**
 * Whether an import edge written in `importer` may load one of `modules`. A literal resolves to its
 * files; a template whose prefix is relative may load every module whose path begins where the
 * prefix resolves, and one whose prefix names a workspace package may load every module of that
 * workspace; a built-in prefix loads none; any other target, computed or unbounded, may load every
 * module of the importer's own workspace.
 */
function edgeMayLoad(importer: string, target: ImportTarget, modules: readonly string[], layout: WorkspaceLayout): boolean {
  if (target.kind === "static") {
    const targets = new Set(specifierTargets(importer, target.specifier));
    return modules.some((m) => targets.has(m));
  }
  if (target.kind === "template") {
    if (target.prefix.startsWith("node:")) return false;
    const bound = templateTarget(target.prefix);
    if (bound === "no-package") {
      const begins = path.posix.normalize(path.posix.join(path.posix.dirname(importer), target.prefix));
      return modules.some((m) => m.startsWith(begins));
    }
    if (bound === "package") {
      if (layout.workspaceDirs === "unknown") return modules.length > 0;
      const dirs = [...layout.workspaceDirs].filter(([name]) => prefixMayName(target.prefix, name)).map(([, dir]) => `${dir}/`);
      return modules.some((m) => dirs.some((dir) => m.startsWith(dir)));
    }
  }
  const workspace = owningWorkspace(importer, layout.manifestDirs);
  return modules.some((m) => owningWorkspace(m, layout.manifestDirs) === workspace);
}

/**
 * The tests among `allTests` whose own import edges (their text read by `read`) may load any of
 * `modules`; see edgeMayLoad for an edge whose target is not spelled whole.
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export function testsImportingDirectly(allTests: readonly string[], modules: readonly string[], read: (file: string) => string | undefined, layout: WorkspaceLayout): string[] {
  return allTests.filter((test) => {
    const text = read(test);
    // A test whose text cannot be read may import any of them, so it stays among the direct tests.
    if (text === undefined) return true;
    return importTargets(test, text).some((target) => edgeMayLoad(test, target, modules, layout));
  });
}

interface Cli {
  readonly base: string;
  readonly head: string | undefined;
  readonly list: boolean;
  readonly config: SelectionConfig;
  readonly vitestArgs: readonly string[];
}

function parseCli(argv: readonly string[]): Cli {
  const split = argv.indexOf("--");
  const own = split === -1 ? argv : argv.slice(0, split);
  const vitestArgs = split === -1 ? [] : argv.slice(split + 1);
  let base: string | undefined;
  let head: string | undefined;
  let list = false;
  let config = DEFAULT_SELECTION_CONFIG;
  for (let i = 0; i < own.length; i++) {
    const arg = own[i];
    if (arg === "--list") list = true;
    else if (arg === "--head") {
      head = own[++i];
      if (head === undefined) throw new AffectedTestsError("--head", "needs a revision");
    } else if (arg === "--cap") {
      const value = own[++i];
      if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new AffectedTestsError("--cap", `needs a positive whole number of test files, got ${String(value)}`);
      config = { maxTests: Number(value) };
    } else if (arg !== undefined && !arg.startsWith("-") && base === undefined) base = arg;
    else throw new AffectedTestsError("arguments", `unexpected ${String(arg)}; usage: affected-tests.ts <base> [--head <rev>] [--cap <n>] [--list] [-- <vitest run args>]`);
  }
  if (base === undefined) throw new AffectedTestsError("arguments", "a base revision is required; usage: affected-tests.ts <base> [--head <rev>] [--cap <n>] [--list] [-- <vitest run args>]");
  return { base, head, list, config, vitestArgs };
}

const VITEST_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "vitest", "vitest.mjs");

function runVitest(root: string, files: readonly string[], extra: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VITEST_BIN, "run", ...extra, ...files.map((f) => path.join(root, f))], { cwd: root, stdio: "inherit" });
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, forward);
    child.on("error", (error) => {
      reject(new AffectedTestsError("vitest run", describeErrorChain(error)));
    });
    child.on("exit", (code, signal) => {
      // A run ended by a signal is a failed run, never a pass.
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
}

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  const root = process.cwd();
  if (!fs.existsSync(VITEST_BIN)) throw new AffectedTestsError("vitest", `${VITEST_BIN} is missing; run npm ci`);
  const { from, paths: changes } = changedPaths(root, cli.base, cli.head);
  const sources = await repositorySources(root, { base: from, head: cli.head });
  let selection: Selection;
  try {
    selection = await selectTests(changes, sources);
  } finally {
    await sources.close();
  }
  console.log(`${changes.length} changed file(s) against ${cli.base}${cli.head === undefined ? " (working tree)" : `..${cli.head}`}`);
  for (const reason of selection.reasons) console.log(`  ${reason}`);
  if (selection.kind === "whole-suite") console.log(`selected: the whole suite (${sources.allTests.length} test files)`);
  else console.log(`selected: ${selection.tests.length} of ${sources.allTests.length} test files`);
  const run = boundSelection(selection, sources.allTests.length, cli.config);
  if (run.kind === "nothing") {
    console.log(run.notice);
    return run.exitCode;
  }
  if (run.kind === "whole-suite") return cli.list ? 0 : runVitest(root, [], cli.vitestArgs);
  if (run.notice !== undefined) console.log(run.notice);
  console.log(`runs: ${run.tests.length} test files`);
  for (const t of run.tests) console.log(`  ${t}`);
  return cli.list ? 0 : runVitest(root, run.tests, cli.vitestArgs);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(describeErrorChain(error));
      process.exitCode = 1;
    },
  );
}

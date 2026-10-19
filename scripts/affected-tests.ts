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
 * the test files whose own import specifiers resolve to a changed module. One line says it was
 * capped and how many files were skipped; the merge lane's full suite runs those. A selection that
 * comes to no test file for a change that touches source fails the run instead of passing it; only a
 * change every path of which a no-test-effect rule clears (or a deleted test file) runs nothing and
 * exits 0.
 *
 * Mechanism: vitest's module graph (the test specifications `vitest related` would run). A test is
 * selected when it imports a changed module through any chain of static imports, or of dynamic
 * imports whose specifier is a literal. On top of the graph, rules for what the graph cannot see,
 * applied to each changed path in this order, the first that decides a path ending it:
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
 *   (a directory listing, a glob, a path joined from parts no single literal spells).
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
 * - The modules globalSetup imports (vitest.config.ts) run in every test run; only the setup file
 *   itself is a whole-suite rule, its own imports reach just the tests that import them.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeErrorChain } from "@ashara/shared";

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

/**
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export const WHOLE_SUITE_RULES: readonly PathRule[] = [
  { pattern: /^migrations\//, reason: "every database test runs on the migrated schema, and no test imports a migration" },
  { pattern: /^boundary-rules\.toml$/, reason: "the boundary lint and the stack-literal scan read it at runtime, and their tests judge the whole tree against it" },
  { pattern: /^eslint\.config\.mjs$/, reason: "the ESLint guard tests lint with it at runtime" },
  { pattern: /(^|\/)tsconfig[^/]*\.json$/, reason: "it changes how every module compiles and resolves" },
  { pattern: /(^|\/)package(-lock)?\.json$/, reason: "it changes which dependency and which workspace module every import resolves to" },
  { pattern: /^vitest\.config\.ts$/, reason: "it changes which files are tests and how every test runs" },
  { pattern: /^packages\/integration\/src\/cell-leak-guard\.ts$/, reason: "vitest.config.ts runs it as globalSetup around every test run" },
  {
    pattern: /^packages\/integration\/src\/podman-test-load\.ts$/,
    reason: "vitest.config.ts reads it for which files are podman tests, how many run at once and their timeouts, and the globalSetup guards for their podman bound",
  },
  { pattern: /^config\//, reason: "the runtime configuration the composition root and the test harness read by a configured path" },
];

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
/** The files vitest's graph reads: the modules tests import, in the trees vitest.config.ts includes. */
const GRAPH_MODULE_RE = /^(packages\/[^/]+\/src|scripts)\/.+\.(ts|mjs|js)$/;

interface SelectionBasis {
  /** The direct tests of the changed files (see the bound in the header), repo-relative, sorted. */
  readonly direct: readonly string[];
  /** Whether any changed path is one whose change must be judged by a test. */
  readonly touchesSource: boolean;
}

type Selection = SelectionBasis &
  (
    | { readonly kind: "whole-suite"; readonly reasons: readonly string[] }
    | {
        readonly kind: "selected";
        /** Repo-relative test files, sorted. */
        readonly tests: readonly string[];
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
  /** Every test file vitest.config.ts includes, repo-relative. */
  readonly allTests: readonly string[];
  /** The test files that import any of these modules through the graph, repo-relative. */
  readonly testsImporting: (modules: readonly string[]) => Promise<readonly string[]>;
  /** The tracked or untracked files whose text contains `name`, repo-relative. */
  readonly filesNaming: (name: string) => readonly string[];
  /** The test files whose own import specifiers resolve to any of these modules (depth 1), repo-relative. */
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
  const allTests = new Set(sources.allTests);

  for (const change of changes) {
    const file = change.path;
    const isDeletedTest = change.status === "deleted" && TEST_FILE_RE.test(file);
    if (!isDeletedTest && !NO_TEST_EFFECT_RULES.some((r) => r.pattern.test(file))) touchesSource = true;
    if (!TEST_FILE_RE.test(file) && GRAPH_MODULE_RE.test(file)) {
      const colocated = file.replace(/\.(ts|mjs|js)$/, ".test.ts");
      if (allTests.has(colocated)) direct.add(colocated);
      if (change.status !== "deleted") changedModules.add(file);
    }
    const rule = WHOLE_SUITE_RULES.find((r) => r.pattern.test(file));
    if (rule !== undefined) {
      wholeSuite.push(`${file}: ${rule.reason}`);
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
  if (wholeSuite.length > 0) return { ...basis, kind: "whole-suite", reasons: wholeSuite };
  if (graphModules.size > 0) for (const t of await sources.testsImporting([...graphModules])) tests.add(t);
  return { ...basis, kind: "selected", tests: [...tests].sort(), reasons };
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
  if (count > config.maxTests) {
    tests = selection.direct;
    notice = `selection capped: ${count} test files exceed the cap of ${config.maxTests}; running the ${tests.length} direct test file(s) of the changed files, ${count - tests.length} skipped; the merge lane's full suite covers them`;
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

function changedPaths(root: string, base: string, head: string | undefined): ChangedPath[] {
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
  return changes;
}

/**
 * The vitest-backed SelectionSources of the repository at `root`, closed by `close`.
 * @testseam affected-tests.test.ts exercises it without running the CLI
 */
export async function repositorySources(root: string): Promise<SelectionSources & { close: () => Promise<void> }> {
  // Imported where it is used: tsx runs this repo's scripts as CommonJS, and vitest/node is ESM only.
  const { createVitest } = await import("vitest/node");
  const vitest = await createVitest("test", { root, watch: false, run: true, reporters: [] });
  const relative = (abs: string): string => path.relative(root, abs).split(path.sep).join("/");
  const allTests = [...new Set((await vitest.globTestSpecifications()).map((s) => relative(s.moduleId)))].sort();
  return {
    allTests,
    testsImporting: async (modules) => {
      vitest.config.related = modules.map((m) => path.join(root, m));
      const specs = await vitest.getRelevantTestSpecifications();
      return [...new Set(specs.map((s) => relative(s.moduleId)))];
    },
    testsImportingDirectly: (modules) => Promise.resolve(testsImportingDirectly(root, allTests, modules)),
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

const IMPORT_SPECIFIER_RE = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

/** The repo-relative files a relative import specifier written in `importer` may resolve to. */
function specifierTargets(importer: string, specifier: string): string[] {
  if (!specifier.startsWith(".")) return [];
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const stem = joined.replace(/\.(js|mjs|ts)$/, "");
  return [joined, `${stem}.ts`, `${stem}.mjs`, `${stem}.js`, `${joined}/index.ts`];
}

function testsImportingDirectly(root: string, allTests: readonly string[], modules: readonly string[]): string[] {
  const wanted = new Set(modules);
  const found: string[] = [];
  for (const test of allTests) {
    const text = fs.readFileSync(path.join(root, test), "utf-8");
    for (const match of text.matchAll(IMPORT_SPECIFIER_RE)) {
      const specifier = match[1];
      if (specifier !== undefined && specifierTargets(test, specifier).some((t) => wanted.has(t))) {
        found.push(test);
        break;
      }
    }
  }
  return found;
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
  const changes = changedPaths(root, cli.base, cli.head);
  const sources = await repositorySources(root);
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

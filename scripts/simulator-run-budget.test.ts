import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { LintContext } from "./lints/lint.js";
import { parseRules } from "./lints/rules.js";
import { run as simulatorRunBudget } from "./lints/simulator-run-budget.js";
import { checkoutProgram } from "./module-program.js";
import { MAX_RUNS_PER_FILE, MAX_SEEDED_RUNS_PER_FILE, findRunBudgetFindings } from "./simulator-run-budget.js";

const SIMULATOR = join(import.meta.dirname, "..", "packages", "integration", "src", "simulator");

/** The run starters a simulator test file finds beside it, as the harness and run.ts export them. */
const STARTERS = {
  "simulator-harness.ts": ["seeded", "replayed", "directed", "liveness"].map((name) => `export function ${name}(..._args: unknown[]): Promise<void> {\n  return Promise.resolve();\n}\n`).join(""),
  "run.ts": "export function runSeed(_options: unknown): Promise<void> {\n  return Promise.resolve();\n}\n",
};

/** What a probe imports unless it says otherwise: vitest's test declarers and the harness's starters, by their own names. */
const HEADER = 'import { beforeAll, describe, it, test } from "vitest";\nimport { directed, liveness, replayed, seeded } from "./simulator-harness.js";\n';

let scratch: string | null = null;

afterEach(() => {
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/**
 * The gate's simulator-run-budget lint over a tree whose simulator directory holds `files` (each file
 * name to its text), on disk and in the integration package's scan, so the probe reads the lint's
 * entry and not the reader's own signature.
 */
const lintTree = (files: Readonly<Record<string, string>>): LintContext => {
  const root = mkdtempSync(join(tmpdir(), "simulator-run-budget-"));
  scratch = root;
  const pkgRoot = join(root, "packages", "integration");
  const dir = join(pkgRoot, "src", "simulator");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const rule = parseRules("[integration]\nallow = []\n", "boundary-rules.toml").get("integration");
  if (rule === undefined) throw new Error("the integration rule did not parse");
  const contents = new Map(Object.entries(files).map(([name, text]): [string, string] => [join(dir, name), text]));
  const scan = { name: "integration", rule, root: pkgRoot, contents, relativeTo: (filePath: string) => filePath.slice(pkgRoot.length + 1) };
  return { root, packagesDir: join(root, "packages"), rulesRelative: "boundary-rules.toml", toml: "", rules: new Map(), packageDirs: ["integration"], packages: [scan] };
};

/** The findings of `source` as a simulator test file, beside `modules` (each file name in its directory to its text) and the starters. */
const reasons = (source: string, modules: Readonly<Record<string, string>> = {}, header = HEADER): string[] =>
  simulatorRunBudget(lintTree({ ...STARTERS, ...modules, "probe.test.ts": `${header}${source}` })).map((violation) => violation.reason);

const tests = (count: number, run: string): string => Array.from({ length: count }, (_, i) => `  it("t${i}", async (ctx) => { await ${run}(ctx, []); });`).join("\n");

describe("findRunBudgetFindings", () => {
  test("passes a file at its budgets and names one over each", () => {
    expect(reasons(`describe("d", () => {\n${tests(MAX_RUNS_PER_FILE, "directed")}\n});`)).toEqual([]);
    expect(reasons(`describe("d", () => {\n${tests(MAX_RUNS_PER_FILE + 1, "directed")}\n});`)).toEqual([expect.stringMatching(/^13 simulator runs in one file, more than 12/)]);
    expect(reasons(`describe("d", () => {\n${tests(MAX_SEEDED_RUNS_PER_FILE + 1, "seeded")}\n});`)).toEqual([expect.stringMatching(/^4 seeded runs in one file, more than 3/)]);
  });

  test("counts a list around a test, a list's entries, an imported list and an it.each list", () => {
    const loop = 'const SEEDS = [1, 2, 4, 10] as const;\nfor (const seed of SEEDS) it("s", async (ctx) => { await seeded(ctx, seed); });';
    expect(reasons(loop)).toEqual([expect.stringMatching(/^4 seeded runs/)]);
    const entries = 'const R = ["a", "b"] as const;\nfor (const [i, r] of R.entries()) it("r", async (ctx) => { await seeded(ctx, i); await replayed(ctx, i, []); });';
    expect(reasons(entries)).toEqual([expect.stringMatching(/^4 seeded runs/)]);
    const imported = 'import { LIST } from "./faults.js";\nfor (const x of LIST) it("x", async (ctx) => { await seeded(ctx, 1); });';
    expect(reasons(imported, { "faults.ts": "export const LIST = [1, 2, 3, 4] as const satisfies readonly number[];" })).toEqual([expect.stringMatching(/^4 seeded runs/)]);
    expect(reasons('it.each([1, 2, 3, 4])("s %i", async (seed) => { await seeded(ctx, seed); });')).toEqual([expect.stringMatching(/^4 seeded runs/)]);
  });

  test("counts the runs a wrapper of the file makes where it is called", () => {
    const wrapper = `function twice(ctx) { return Promise.all([seeded(ctx, 1), seeded(ctx, 2)]); }\n${tests(2, "twice")}`;
    expect(reasons(wrapper)).toEqual([expect.stringMatching(/^4 seeded runs/)]);
    const arrow = `const adversarial = (ctx, d) => directed(ctx, d, { profile: "adversarial" });\n${tests(MAX_RUNS_PER_FILE + 1, "adversarial")}`;
    expect(reasons(arrow)).toEqual([expect.stringMatching(/^13 simulator runs/)]);
    expect(reasons('async function all(ctx) { for (const s of [1, 2]) await seeded(ctx, s); }\nit("all", async (ctx) => { await all(ctx); });')).toEqual([
      expect.stringMatching(/^seeded runs inside a loop in one test/),
    ]);
  });

  test("names a loop of runs inside one test, a list it cannot count and a run outside any test", () => {
    expect(reasons('it("all", async (ctx) => { for (const seed of [1, 2]) await seeded(ctx, seed); });')).toEqual([expect.stringMatching(/^seeded runs inside a loop in one test/)]);
    expect(reasons('it("all", async (ctx) => { await Promise.all([1, 2].map((s) => seeded(ctx, s))); });')).toEqual([expect.stringMatching(/^seeded runs inside a loop in one test \(\.map\)/)]);
    expect(reasons('import { LIST } from "@ashara/x";\nfor (const x of LIST) it("x", async (ctx) => { await directed(ctx, []); });')).toEqual([expect.stringMatching(/^a list around this test that the check cannot count/)]);
    expect(reasons('beforeAll(async () => { await directed(ctx, []); });')).toEqual(["directed runs outside any test"]);
  });

  test("follows an imported list by the checker, under another name and through a re-export, and refuses one a let binds", () => {
    const renamed = 'import { SEEDS as LIST } from "./faults.js";\nfor (const x of LIST) it("x", async (ctx) => { await seeded(ctx, x); });';
    const modules = { "faults.ts": 'export { SEEDS } from "./lists.js";\n', "lists.ts": "export const SEEDS = [1, 2, 3, 4] as const;\n" };
    expect(reasons(renamed, modules)).toEqual([expect.stringMatching(/^4 seeded runs/)]);
    const reassignable = 'let LIST = [1, 2, 3, 4];\nLIST = [...LIST, 5];\nfor (const x of LIST) it("x", async (ctx) => { await seeded(ctx, x); });';
    expect(reasons(reassignable)).toEqual([expect.stringMatching(/^a list around this test that the check cannot count/)]);
  });

  test("a run starter or a test declarer the file reads under another name, off a namespace or through a re-export is the one the checker resolves it to", () => {
    const header = 'import { it as check } from "vitest";\n';
    const over = `${MAX_SEEDED_RUNS_PER_FILE + 1} seeded runs`;
    expect(reasons(`import { seeded as s } from "./simulator-harness.js";\n${tests(MAX_SEEDED_RUNS_PER_FILE + 1, "s").replaceAll("it(", "check(")}`, {}, header)).toEqual([expect.stringContaining(over)]);
    expect(reasons(`import * as h from "./simulator-harness.js";\n${tests(MAX_SEEDED_RUNS_PER_FILE + 1, "h.seeded")}`, {}, 'import * as v from "vitest";\nconst { it } = v;\n')).toEqual([expect.stringContaining(over)]);
    expect(reasons(`import { again } from "./helpers.js";\n${tests(MAX_SEEDED_RUNS_PER_FILE + 1, "again")}`, { "helpers.ts": 'export { seeded as again } from "./simulator-harness.js";\n' })).toEqual([expect.stringContaining(over)]);
    expect(reasons('import { runSeed as start } from "./run.js";\nstart({});\n')).toEqual(["runSeed runs outside any test"]);
  });

  test("a function the file names like a run starter is no run starter, and a call of one is no test unless vitest declares it", () => {
    expect(reasons(`function seeded(_ctx: unknown, _s: number): void {}\n${tests(MAX_SEEDED_RUNS_PER_FILE + 1, "seeded")}`, {}, 'import { it } from "vitest";\n')).toEqual([]);
    expect(reasons(`declare function it(name: string, body: () => Promise<void>): void;\n${tests(MAX_SEEDED_RUNS_PER_FILE + 1, "seeded")}`, {}, 'import { seeded } from "./simulator-harness.js";\n')).toEqual(
      Array.from({ length: MAX_SEEDED_RUNS_PER_FILE + 1 }, () => "seeded runs outside any test"),
    );
  });

  test("a file whose starters' module the program does not hold fails the read: a scan of no starter would count no run", () => {
    expect(() => simulatorRunBudget(lintTree({ "probe.test.ts": `${HEADER}${tests(1, "seeded")}` }))).toThrow("simulator-harness.ts");
  });

  test("a name that shadows the list in an inner scope is not the list the loop reads", () => {
    const shadowed = 'const LIST = [1, 2, 3, 4];\nfunction other(): number[] { const LIST = [1]; return LIST; }\nvoid other;\nfor (const x of LIST) it("x", async (ctx) => { await seeded(ctx, x); });';
    expect(reasons(shadowed)).toEqual([expect.stringMatching(/^4 seeded runs/)]);
  });

  test("the simulator's test files are within their budgets", () => {
    const files = readdirSync(SIMULATOR).filter((name) => name.endsWith(".ts"));
    expect(files.some((name) => name.endsWith(".test.ts"))).toBe(true);
    const built = checkoutProgram(new Map(files.map((name): [string, string] => [join(SIMULATOR, name), readFileSync(join(SIMULATOR, name), "utf-8")])));
    expect(files.filter((name) => name.endsWith(".test.ts")).flatMap((name) => findRunBudgetFindings(built, join(SIMULATOR, name), name))).toEqual([]);
  });
});

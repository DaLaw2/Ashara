import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MAX_RUNS_PER_FILE, MAX_SEEDED_RUNS_PER_FILE, findRunBudgetFindings } from "./simulator-run-budget.js";
import type { ModuleReader } from "./simulator-run-budget.js";

const SIMULATOR = join(import.meta.dirname, "..", "packages", "integration", "src", "simulator");
const noModules: ModuleReader = () => null;

const reasons = (source: string, readModule: ModuleReader = noModules): string[] => findRunBudgetFindings(source, "probe.test.ts", readModule).map((finding) => finding.reason);

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
    expect(reasons(imported, () => "export const LIST = [1, 2, 3, 4] as const satisfies readonly number[];")).toEqual([expect.stringMatching(/^4 seeded runs/)]);
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

  test("the simulator's test files are within their budgets", () => {
    const files = readdirSync(SIMULATOR).filter((name) => name.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    const readModule: ModuleReader = (specifier) => (specifier.startsWith("./") ? readFileSync(join(SIMULATOR, specifier.replace(/\.js$/, ".ts")), "utf-8") : null);
    expect(files.flatMap((name) => findRunBudgetFindings(readFileSync(join(SIMULATOR, name), "utf-8"), name, readModule))).toEqual([]);
  });
});

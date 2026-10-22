import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { LintContext } from "./lint.js";
import { run as recognisedWording } from "./recognised-wording.js";

const REPO = path.join(import.meta.dirname, "..", "..");
const LINTS_DIR = import.meta.dirname;
const RUNNER = path.join(REPO, "scripts", "check-boundaries.ts");

/** Lint modules hold one lint each; these are the shared readers and helpers the lints build on. */
const HELPERS = new Set(["lint.ts", "rules.ts", "source-files.ts", "stand-ins.ts"]);

const SIMULATOR = "packages/integration/src/simulator";
const WORDING = `export const CONFLICT_HEADING = "## Merge with main in progress";\n`;

let scratch: string | null = null;

afterEach(() => {
  if (scratch !== null) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** A tree holding only the simulator's wording module and `others`, each a simulator file by its relative path. */
function simulatorTree(others: Readonly<Record<string, string>>): LintContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recognised-wording-"));
  scratch = root;
  const write = (relative: string, content: string): void => {
    const target = path.join(root, SIMULATOR, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write("stand-ins/recognised-wording.ts", WORDING);
  for (const [relative, content] of Object.entries(others)) write(relative, content);
  return { root, packagesDir: path.join(root, "packages"), rulesRelative: "boundary-rules.toml", toml: "", rules: new Map(), packageDirs: [], packages: [] };
}

function lintModules(): string[] {
  return fs.readdirSync(LINTS_DIR).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !HELPERS.has(file)).sort();
}

describe("the boundary gate's runner", () => {
  test("its main is under 60 lines", () => {
    const lines = fs.readFileSync(RUNNER, "utf-8").split("\n");
    const start = lines.findIndex((line) => /^function main\(/.test(line));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, i) => i > start && line === "}");
    expect(end).toBeGreaterThan(start);
    expect(end - start + 1).toBeLessThan(60);
  });

  test("every lint module exports run and the runner imports each one", async () => {
    const runner = fs.readFileSync(RUNNER, "utf-8");
    const modules = lintModules();
    expect(modules.length).toBeGreaterThan(0);
    for (const file of modules) {
      const lint: unknown = await import(path.join(LINTS_DIR, file));
      expect(lint, file).toHaveProperty("run", expect.any(Function));
      expect(runner, file).toContain(`from "./lints/${file.replace(/\.ts$/, ".js")}"`);
    }
  });
});

describe("recognised-wording", () => {
  test("a recognised heading copied into another simulator file is a violation", () => {
    const context = simulatorTree({ "coverage.ts": `const heading = "## Merge with main in progress";\n` });
    const violations = recognisedWording(context);
    expect(violations.map((v) => `${v.file}:${v.line}`)).toEqual([`${SIMULATOR}/coverage.ts:1`]);
  });

  test("a simulator file importing the heading is clean", () => {
    const context = simulatorTree({ "coverage.ts": `import { CONFLICT_HEADING } from "./stand-ins/recognised-wording.js";\n` });
    expect(recognisedWording(context)).toEqual([]);
  });

  test("a missing wording module fails closed", () => {
    const context = simulatorTree({});
    fs.rmSync(path.join(context.root, SIMULATOR, "stand-ins", "recognised-wording.ts"));
    expect(recognisedWording(context)).toHaveLength(1);
  });

  test("the repository's simulator spells every recognised wording once", () => {
    const context: LintContext = { root: REPO, packagesDir: path.join(REPO, "packages"), rulesRelative: "boundary-rules.toml", toml: "", rules: new Map(), packageDirs: [], packages: [] };
    expect(recognisedWording(context)).toEqual([]);
  });
});

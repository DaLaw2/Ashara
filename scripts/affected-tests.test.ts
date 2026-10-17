import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseNameStatus, repositorySources, selectTests, SIMULATOR_DIR, WHOLE_SUITE_RULES, type ChangedPath, type SelectionSources } from "./affected-tests.js";

const REPO = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(import.meta.dirname, "affected-tests.ts");
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

function stubSources(over: Partial<SelectionSources> = {}): SelectionSources {
  return {
    allTests: ["packages/a/src/a.test.ts", `${SIMULATOR_DIR}one.test.ts`, `${SIMULATOR_DIR}two.test.ts`, "packages/integration/src/workplace/snap.test.ts"],
    testsImporting: () => Promise.resolve(["packages/a/src/a.test.ts"]),
    filesNaming: () => [],
    ...over,
  };
}

const modified = (p: string): ChangedPath => ({ path: p, status: "modified" });

describe("the whole-suite rules", () => {
  // One path per rule; a rule added without a path here fails the coverage check below.
  const WHOLE_SUITE_PATHS = [
    "migrations/added.sql",
    "boundary-rules.toml",
    "eslint.config.mjs",
    "tsconfig.json",
    "packages/db/tsconfig.json",
    "package.json",
    "packages/shared/package.json",
    "package-lock.json",
    "vitest.config.ts",
    "packages/integration/src/cell-leak-guard.ts",
    "config/models.toml",
  ];

  test("every rule is exercised by a path here", () => {
    for (const rule of WHOLE_SUITE_RULES) expect(WHOLE_SUITE_PATHS.some((p) => rule.pattern.test(p)), rule.reason).toBe(true);
  });

  test.each(WHOLE_SUITE_PATHS)("a change to %s selects the whole suite, beside a module change", async (file) => {
    const selection = await selectTests([modified("packages/a/src/a.ts"), modified(file)], stubSources());
    expect(selection.kind).toBe("whole-suite");
    expect(selection.reasons.join("\n")).toContain(file);
  });

  test("a deleted or renamed module selects the whole suite: its importers are not in the graph", async () => {
    expect((await selectTests([{ path: "packages/a/src/gone.ts", status: "deleted" }], stubSources())).kind).toBe("whole-suite");
    const renamed = parseNameStatus("R090\0packages/a/src/old.ts\0packages/a/src/new.ts\0");
    expect((await selectTests(renamed, stubSources())).kind).toBe("whole-suite");
  });

  test("a file no rule classifies and nothing names selects the whole suite", async () => {
    expect((await selectTests([modified("packages/server/web/app.css")], stubSources())).kind).toBe("whole-suite");
  });

  test("no change at all is refused, not read as an empty selection", async () => {
    await expect(selectTests([], stubSources())).rejects.toThrow(/no file differs/);
  });
});

describe("the selected rules", () => {
  test("a changed test file selects itself; a snapshot selects its test file", async () => {
    const selection = await selectTests(
      [modified("packages/b/src/b.test.ts"), modified("packages/integration/src/workplace/__snapshots__/snap.test.ts.snap")],
      stubSources({ testsImporting: () => Promise.reject(new Error("the graph is not asked when no module changed")) }),
    );
    expect(selection).toMatchObject({ kind: "selected", tests: ["packages/b/src/b.test.ts", "packages/integration/src/workplace/snap.test.ts"] });
  });

  test("a simulator module selects every simulator test and its graph dependants", async () => {
    const selection = await selectTests([modified(`${SIMULATOR_DIR}faults.ts`)], stubSources());
    expect(selection).toMatchObject({ kind: "selected", tests: ["packages/a/src/a.test.ts", `${SIMULATOR_DIR}one.test.ts`, `${SIMULATOR_DIR}two.test.ts`] });
  });

  test("a non-module file named by a module selects that module's dependants, and a test that names it", async () => {
    const asked: string[] = [];
    const selection = await selectTests(
      [modified("packages/server/web/app.css")],
      stubSources({
        filesNaming: (name) => (name === "app.css" ? ["packages/server/src/web-client.ts", "packages/integration/src/workplace/snap.test.ts"] : []),
        testsImporting: (modules) => {
          asked.push(...modules);
          return Promise.resolve(["packages/a/src/a.test.ts"]);
        },
      }),
    );
    expect(asked).toEqual(["packages/server/src/web-client.ts"]);
    expect(selection).toMatchObject({ kind: "selected", tests: ["packages/a/src/a.test.ts", "packages/integration/src/workplace/snap.test.ts"] });
  });

  test("a file the no-test-effect rules clear selects nothing", async () => {
    expect(await selectTests([modified("README.md")], stubSources())).toMatchObject({ kind: "selected", tests: [] });
  });

  test("an unknown git status fails the parse instead of being skipped", () => {
    expect(() => parseNameStatus("X\0packages/a/src/a.ts\0")).toThrow(/not one this script classifies/);
  });
});

describe("this repository's graph", () => {
  test("a shared kernel module selects tests in other packages that reach it only through other modules", async () => {
    const sources = await repositorySources(REPO);
    try {
      const tests = await sources.testsImporting(["packages/shared/src/json.ts"]);
      expect(tests).toContain("packages/shared/src/json.test.ts");
      // engagement's vision test imports engagement's vision module, which reaches shared's json.ts
      // through @ashara/shared's index: two imports away, across a workspace link.
      expect(tests).toContain("packages/engagement/src/vision.test.ts");
      expect(tests).not.toContain("scripts/stack-literals.test.ts");
    } finally {
      await sources.close();
    }
  });
});

// The proof the selection is sound where it matters: a break planted in a module the test reaches
// only through two other modules, one across a workspace package link, is selected and fails the run.
describe("a planted break in a scratch repository", () => {
  let dir: string;

  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "ignore" });
  };

  interface CliRun {
    readonly code: number | null;
    readonly output: string;
  }

  const runCli = (...args: string[]): Promise<CliRun> => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("VITEST") && key !== "NODE_OPTIONS") env[key] = value;
    }
    return new Promise((resolve) => {
      execFile(process.execPath, [TSX, SCRIPT, ...args], { cwd: dir, env, timeout: 100_000 }, (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
        resolve({ code, output: `${stdout}\n${stderr}` });
      });
    });
  };

  const write = async (file: string, text: string): Promise<void> => {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  };

  const LEAF = "export function double(n: number): number {\n  return n * 2;\n}\n";

  beforeAll(async () => {
    // Inside the repository, so the scratch tests resolve vitest from its node_modules.
    dir = await mkdtemp(path.join(import.meta.dirname, ".affected-probe-"));
    await write("vitest.config.mjs", 'export default { test: { include: ["packages/*/src/**/*.test.ts"] } };\n');
    await write("packages/leaf/package.json", JSON.stringify({ name: "@probe/leaf", type: "module", exports: { ".": "./src/index.ts" } }));
    await write("packages/leaf/src/index.ts", 'export { double } from "./double.js";\n');
    await write("packages/leaf/src/double.ts", LEAF);
    await write("packages/mid/src/quadruple.ts", 'import { double } from "@probe/leaf";\nexport const quadruple = (n: number): number => double(double(n));\n');
    await write("packages/top/src/top.test.ts", 'import { expect, test } from "vitest";\nimport { quadruple } from "../../mid/src/quadruple.js";\ntest("quadruples", () => {\n  expect(quadruple(2)).toBe(8);\n});\n');
    await write("packages/other/src/other.test.ts", 'import { expect, test } from "vitest";\ntest("stands alone", () => {\n  expect(1).toBe(1);\n});\n');
    await mkdir(path.join(dir, "node_modules", "@probe"), { recursive: true });
    await symlink(path.join(dir, "packages", "leaf"), path.join(dir, "node_modules", "@probe", "leaf"));
    await write(".gitignore", "node_modules/\n");
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "probe");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a harmless change to the leaf selects the test two imports away, and the run passes", async () => {
    await write("packages/leaf/src/double.ts", `// harmless\n${LEAF}`);
    const run = await runCli("main");
    expect(run.output).toContain("selected: 1 of 2 test files");
    expect(run.output).toContain("packages/top/src/top.test.ts");
    expect(run.code, run.output).toBe(0);
  });

  test("a break planted in the leaf is selected and fails the selected run", async () => {
    await write("packages/leaf/src/double.ts", 'export function double(): number {\n  throw new Error("planted break");\n}\n');
    const run = await runCli("main");
    expect(run.output).toContain("packages/top/src/top.test.ts");
    expect(run.output).not.toMatch(/^ {2}packages\/other\/src\/other\.test\.ts$/m);
    expect(run.output).toContain("planted break");
    expect(run.code, run.output).not.toBe(0);
    expect(run.code, run.output).not.toBeNull();
  });

  test("a package manifest change fires the whole-suite rule", async () => {
    await write("packages/leaf/src/double.ts", LEAF);
    await write("packages/leaf/package.json", JSON.stringify({ name: "@probe/leaf", type: "module", version: "0.0.1", exports: { ".": "./src/index.ts" } }));
    const run = await runCli("main", "--list");
    expect(run.output).toContain("selected: the whole suite (2 test files)");
    expect(run.output).toContain("packages/leaf/package.json");
    expect(run.code, run.output).toBe(0);
  });
});

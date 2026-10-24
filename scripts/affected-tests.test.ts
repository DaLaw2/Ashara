import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { boundSelection, parseNameStatus, repositorySources, selectTests, SIMULATOR_DIR, WHOLE_SUITE_RULES, type ChangedPath, type SelectionSources } from "./affected-tests.js";

const REPO = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(import.meta.dirname, "affected-tests.ts");
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

function stubSources(over: Partial<SelectionSources> = {}): SelectionSources {
  return {
    allTests: ["packages/a/src/a.test.ts", `${SIMULATOR_DIR}one.test.ts`, `${SIMULATOR_DIR}two.test.ts`, "packages/integration/src/workplace/snap.test.ts"],
    testsImporting: () => Promise.resolve(["packages/a/src/a.test.ts"]),
    filesNaming: () => [],
    testsImportingDirectly: () => Promise.resolve([]),
    files: [],
    readRevision: () => undefined,
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
    "vitest.config.mts",
    "packages/integration/src/cell-leak-guard.ts",
    "packages/integration/src/podman-test-load.ts",
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

describe("the cap", () => {
  const CORE = "packages/a/src/core.ts";
  const COLOCATED = "packages/a/src/core.test.ts";
  const IMPORTER = "packages/b/src/b.test.ts";
  const TRANSITIVE = ["packages/c/src/c1.test.ts", "packages/c/src/c2.test.ts", "packages/c/src/c3.test.ts", "packages/c/src/c4.test.ts", "packages/c/src/c5.test.ts"];
  const ALL = [COLOCATED, IMPORTER, ...TRANSITIVE, "packages/d/src/unrelated.test.ts"];

  // core.ts is imported by its colocated test and b.test.ts directly, and by the c tests through b.
  const graph = stubSources({
    allTests: ALL,
    testsImporting: (modules) => Promise.resolve(modules.includes(CORE) ? [COLOCATED, IMPORTER, ...TRANSITIVE] : []),
    testsImportingDirectly: (modules) => Promise.resolve(modules.includes(CORE) ? [IMPORTER] : []),
  });

  test("a related set under the cap runs whole, with no cap line", async () => {
    const run = boundSelection(await selectTests([modified(CORE)], graph), ALL.length, { maxTests: 10 });
    expect(run).toEqual({ kind: "tests", tests: [COLOCATED, ...TRANSITIVE, IMPORTER].sort(), notice: undefined });
  });

  test("a related set over the cap runs only the direct tests and says so", async () => {
    const run = boundSelection(await selectTests([modified(CORE)], graph), ALL.length, { maxTests: 3 });
    expect(run).toMatchObject({ kind: "tests", tests: [COLOCATED, IMPORTER] });
    if (run.kind !== "tests") throw new Error("expected a test run");
    expect(run.notice).toMatch(/^selection capped: 7 test files exceed the cap of 3; running the 2 direct test file\(s\).*, 5 skipped; the merge lane's full suite covers them$/);
  });

  test("a whole-suite verdict over the cap falls back to the direct tests", async () => {
    const selection = await selectTests([modified(CORE), modified("migrations/added.sql")], graph);
    expect(selection.kind).toBe("whole-suite");
    const run = boundSelection(selection, ALL.length, { maxTests: 3 });
    expect(run).toMatchObject({ kind: "tests", tests: [COLOCATED, IMPORTER] });
    if (run.kind !== "tests") throw new Error("expected a test run");
    expect(run.notice).toContain("8 test files exceed the cap of 3");
    expect(run.notice).toContain("6 skipped; the merge lane's full suite covers them");
    expect(boundSelection(selection, ALL.length, { maxTests: 8 })).toEqual({ kind: "whole-suite", count: 8 });
  });

  test("a source change that selects no test fails the run; a change that touches no source passes it", async () => {
    const orphan = boundSelection(await selectTests([modified("packages/d/src/orphan.ts")], graph), ALL.length, { maxTests: 10 });
    expect(orphan).toMatchObject({ kind: "nothing", exitCode: 1 });
    const cappedToNothing = boundSelection(await selectTests([modified("migrations/added.sql")], graph), ALL.length, { maxTests: 3 });
    expect(cappedToNothing).toMatchObject({ kind: "nothing", exitCode: 1 });
    const docs = boundSelection(await selectTests([modified("README.md")], graph), ALL.length, { maxTests: 10 });
    expect(docs).toMatchObject({ kind: "nothing", exitCode: 0 });
  });

  test("a cap that is not a positive whole number is refused", async () => {
    const selection = await selectTests([modified(CORE)], graph);
    expect(() => boundSelection(selection, ALL.length, { maxTests: 0 })).toThrow(/not a positive whole number/);
  });
});

describe("a dependency change", () => {
  // Three workspaces: a resolves hono, b resolves a through its link, c resolves neither; the root
  // project resolves zod and vitest. scripts/ holds the root project's tests.
  const TESTS = {
    a: ["packages/a/src/a1.test.ts", "packages/a/src/a2.test.ts"],
    b: ["packages/b/src/b1.test.ts", "packages/b/src/b2.test.ts"],
    c: ["packages/c/src/c1.test.ts", "packages/c/src/c2.test.ts"],
    root: ["scripts/s1.test.ts", "scripts/s2.test.ts"],
  };
  const ALL = [...TESTS.a, ...TESTS.b, ...TESTS.c, ...TESTS.root].sort();
  const A_MODULE = "packages/a/src/server.ts";
  const HONO_IMPORTER = "packages/c/src/undeclared.ts";
  const IMPORTS_A = "scripts/s1.test.ts";
  const IMPORTS_HONO = "packages/c/src/c1.test.ts";

  const lockfile = (honoVersion: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      name: "probe",
      lockfileVersion: 3,
      packages: {
        "": { name: "probe", workspaces: ["packages/*"], devDependencies: { vitest: "4.0.0", zod: "4.0.0" } },
        "node_modules/vitest": { version: "4.0.0" },
        "node_modules/zod": { version: "4.0.0" },
        "node_modules/hono": { version: honoVersion, dependencies: { tiny: "1.0.0" } },
        "node_modules/hono/node_modules/tiny": { version: "1.0.0" },
        "node_modules/@p/a": { resolved: "packages/a", link: true },
        "node_modules/@p/b": { resolved: "packages/b", link: true },
        "node_modules/@p/c": { resolved: "packages/c", link: true },
        "packages/a": { name: "@p/a", dependencies: { hono: honoVersion } },
        "packages/b": { name: "@p/b", dependencies: { "@p/a": "*" } },
        "packages/c": { name: "@p/c" },
        ...extra,
      },
    });

  const sources = (base: string | undefined, head: string | undefined): SelectionSources =>
    stubSources({
      allTests: ALL,
      files: [...ALL, A_MODULE, HONO_IMPORTER, "packages/c/src/plain.ts", "package.json", "package-lock.json"],
      readRevision: (file, side) => (file === "package-lock.json" ? (side === "base" ? base : head) : undefined),
      filesNaming: (name) => (name === '"hono"' ? [HONO_IMPORTER] : name === '"@p/a"' ? ["packages/b/src/uses-a.ts"] : []),
      testsImporting: (modules) =>
        Promise.resolve([...(modules.includes(A_MODULE) ? [IMPORTS_A] : []), ...(modules.includes(HONO_IMPORTER) ? [IMPORTS_HONO] : [])]),
    });

  const upgrade = [modified("packages/a/package.json"), modified("package-lock.json")];

  test("a hono upgrade in a workspace manifest and the lockfile selects every test of each workspace that resolves it, and the tests that reach them", async () => {
    const selection = await selectTests(upgrade, sources(lockfile("4.0.0"), lockfile("4.1.0")));
    if (selection.kind !== "selected") throw new Error(`expected a selection, got the whole suite: ${selection.reasons.join("; ")}`);
    const expected = [...TESTS.a, ...TESTS.b, IMPORTS_A, IMPORTS_HONO].sort();
    expect(selection.tests).toEqual(expected);
    expect(selection.required).toEqual(expected);
    expect(selection.tests).not.toContain("packages/c/src/c2.test.ts");
    expect(selection.tests).not.toContain("scripts/s2.test.ts");
  });

  test("the cap never trims a dependency change's tests", async () => {
    const selection = await selectTests([modified("packages/c/src/plain.ts"), ...upgrade], sources(lockfile("4.0.0"), lockfile("4.1.0")));
    const run = boundSelection(selection, ALL.length, { maxTests: 1 });
    if (run.kind !== "tests") throw new Error(`expected a test run, got ${run.kind}`);
    expect(run.tests).toEqual([...TESTS.a, ...TESTS.b, IMPORTS_A, IMPORTS_HONO].sort());
    expect(run.notice).toContain("every test file of the changed dependencies");
  });

  test("a selection over the cap that the kept tests cover whole says none is skipped, never that zero were", async () => {
    const selection = await selectTests(upgrade, sources(lockfile("4.0.0"), lockfile("4.1.0")));
    const run = boundSelection(selection, ALL.length, { maxTests: 1 });
    if (run.kind !== "tests") throw new Error(`expected a test run, got ${run.kind}`);
    expect(run.tests).toHaveLength(6);
    expect(run.notice).toBe("6 test files exceed the cap of 1; running the 6 direct test file(s) of the changed files and every test file of the changed dependencies, which skips none of them");
  });

  // One path per capped whole-suite rule; a capped rule added without a path here fails the check below.
  const CAPPED_PATHS = ["migrations/zzzz_probe.sql", "boundary-rules.toml", "eslint.config.mjs", "tsconfig.json", "packages/integration/src/cell-leak-guard.ts", "packages/integration/src/podman-test-load.ts", "config/probe.toml"];

  test("every capped whole-suite rule has a probe path", () => {
    for (const rule of WHOLE_SUITE_RULES.filter((r) => r.capped)) expect(CAPPED_PATHS.some((f) => rule.pattern.test(f)), rule.pattern.source).toBe(true);
  });

  test.each(CAPPED_PATHS)("a capped whole-suite path (%s) in the same change never trims a dependency change's tests", async (file) => {
    const head = lockfile("4.0.0", { "node_modules/hono": { version: "4.0.0-probe", dependencies: { tiny: "1.0.0" } } });
    const selection = await selectTests([modified("package-lock.json"), modified(file)], sources(lockfile("4.0.0"), head));
    expect(selection).toMatchObject({ kind: "whole-suite", capped: true });
    expect(selection.reasons.join("\n")).toMatch(/^package-lock\.json: /m);
    const run = boundSelection(selection, ALL.length, { maxTests: 1 });
    if (run.kind !== "tests") throw new Error(`expected a test run, got ${run.kind}`);
    expect(run.tests).toEqual([...TESTS.a, ...TESTS.b, IMPORTS_A, IMPORTS_HONO].sort());
    expect(run.notice).toContain("every test file of the changed dependencies");
  });

  test("a nested copy resolves to the workspaces that resolve its parent, and to every module that imports the parent by name", async () => {
    const base = lockfile("4.0.0");
    const head = lockfile("4.0.0", { "node_modules/hono/node_modules/tiny": { version: "1.0.1" } });
    const selection = await selectTests([modified("package-lock.json")], sources(base, head));
    expect(selection).toMatchObject({ kind: "selected", required: [...TESTS.a, ...TESTS.b, IMPORTS_A, IMPORTS_HONO].sort() });
  });

  const DYNAMIC_LOADER = "packages/c/src/loader.ts";
  const loaderSources = (loaderText: string | undefined, loader = DYNAMIC_LOADER): SelectionSources => {
    const base = sources(lockfile("4.0.0"), lockfile("4.1.0"));
    return {
      ...base,
      files: [...base.files, loader, "packages/a/package.json", "packages/b/package.json", "packages/c/package.json"],
      filesNaming: (name) => (name === "import(" ? [loader] : base.filesNaming(name)),
      readRevision: (file, side) => (file === loader ? loaderText : base.readRevision(file, side)),
      testsImporting: async (modules) => [...(await base.testsImporting(modules)), ...(modules.includes(DYNAMIC_LOADER) ? ["packages/c/src/c2.test.ts"] : [])],
    };
  };
  const honoUpgrade = [modified("package-lock.json")];
  const HONO_SELECTION = [...TESTS.a, ...TESTS.b, IMPORTS_A, IMPORTS_HONO];

  test("a template-literal dynamic import whose static prefix names a changed package selects the importer's dependants", async () => {
    const selection = await selectTests(honoUpgrade, loaderSources("export const load = (x: string) => import(`hono/${x}`);\n"));
    expect(selection).toMatchObject({ kind: "selected", required: [...HONO_SELECTION, "packages/c/src/c2.test.ts"].sort() });
  });

  test("a template-literal dynamic import of another package or a relative module selects nothing more", async () => {
    for (const text of ["import(`honorific/${x}`);", "import(`./plugins/${x}.js`);", "import(`node:${x}`);"]) {
      const selection = await selectTests(honoUpgrade, loaderSources(text));
      expect(selection, text).toMatchObject({ kind: "selected", required: [...HONO_SELECTION].sort() });
    }
  });

  test.each([
    ["a computed specifier", "export const load = (target: string) => import(target);\n"],
    ["a template with no static prefix", "export const load = (x: string) => import(`${x}/index.js`);\n"],
    ["a loader whose text cannot be read", undefined],
  ])("a dynamic import with %s fails closed to every test of the importer's workspace", async (_name, text) => {
    const selection = await selectTests(honoUpgrade, loaderSources(text));
    expect(selection).toMatchObject({ kind: "selected", required: [...new Set([...HONO_SELECTION, ...TESTS.c])].sort() });
  });

  test("a computed dynamic import outside every workspace manifest fails closed to the root project's own files", async () => {
    const selection = await selectTests(honoUpgrade, loaderSources("await import(target);\n", "scripts/loader.ts"));
    expect(selection).toMatchObject({ kind: "selected", required: [...new Set([...HONO_SELECTION, ...TESTS.root])].sort() });
  });

  test.each([
    ["an entry the root project resolves", lockfile("4.0.0"), lockfile("4.0.0", { "node_modules/zod": { version: "4.1.0" } }), /root project resolves node_modules\/zod/],
    ["an entry no workspace resolves", lockfile("4.0.0"), lockfile("4.0.0", { "node_modules/orphan": { version: "1.0.0" } }), /no workspace resolves node_modules\/orphan/],
    ["a lockfile absent at the base", undefined, lockfile("4.0.0"), /absent at the base/],
    ["a file that differs with no entry differing", lockfile("4.0.0"), lockfile("4.0.0"), /no locked entry does/],
  ])("%s selects the whole suite, which the cap never trims", async (_name, base, head, reason) => {
    const selection = await selectTests([modified("package-lock.json")], sources(base, head));
    expect(selection).toMatchObject({ kind: "whole-suite", capped: false });
    expect(selection.reasons.join("\n")).toMatch(reason);
    expect(boundSelection(selection, ALL.length, { maxTests: 1 })).toEqual({ kind: "whole-suite", count: ALL.length });
  });

  test("the root manifest and the vitest config select the whole suite past the cap; a migration's whole suite stays capped", async () => {
    for (const file of ["package.json", "vitest.config.mts"]) {
      const selection = await selectTests([modified(file)], sources(lockfile("4.0.0"), lockfile("4.0.0")));
      expect(boundSelection(selection, ALL.length, { maxTests: 1 }), file).toEqual({ kind: "whole-suite", count: ALL.length });
    }
    const migration = await selectTests([modified("migrations/added.sql")], sources(lockfile("4.0.0"), lockfile("4.0.0")));
    expect(boundSelection(migration, ALL.length, { maxTests: 1 })).toMatchObject({ kind: "nothing", exitCode: 1 });
  });

  test("a manifest outside the workspaces the lockfile records selects the whole suite", async () => {
    const selection = await selectTests([modified("packages/z/package.json")], sources(lockfile("4.0.0"), lockfile("4.0.0")));
    expect(selection).toMatchObject({ kind: "whole-suite", capped: false });
  });

  test("a lockfile not of the npm shape fails the selection", async () => {
    await expect(selectTests([modified("package-lock.json")], sources(lockfile("4.0.0"), '{"packages": []}'))).rejects.toThrow(/package-lock\.json at the head/);
  });
});

describe("this repository's graph", () => {
  test("the direct importers are the tests whose own specifiers resolve to the module", async () => {
    const sources = await repositorySources(REPO, { base: "HEAD", head: "HEAD" });
    try {
      const tests = await sources.testsImportingDirectly(["packages/shared/src/json.ts"]);
      expect(tests).toContain("packages/shared/src/json.test.ts");
      expect(tests).not.toContain("packages/engagement/src/vision.test.ts");
    } finally {
      await sources.close();
    }
  });


  test("a shared kernel module selects tests in other packages that reach it only through other modules", async () => {
    const sources = await repositorySources(REPO, { base: "HEAD", head: "HEAD" });
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
    await write(
      "package-lock.json",
      JSON.stringify({
        name: "probe",
        lockfileVersion: 3,
        packages: {
          "": { name: "probe", workspaces: ["packages/*"] },
          "node_modules/@probe/leaf": { resolved: "packages/leaf", link: true },
          "packages/leaf": { name: "@probe/leaf" },
        },
      }),
    );
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

  test("a workspace manifest change selects the tests that reach the workspace, and not the others", async () => {
    await write("packages/leaf/src/double.ts", LEAF);
    await write("packages/leaf/package.json", JSON.stringify({ name: "@probe/leaf", type: "module", version: "0.0.1", exports: { ".": "./src/index.ts" } }));
    const run = await runCli("main", "--list", "--cap", "1");
    expect(run.output).toContain("packages/leaf/package.json: the manifest of workspace packages/leaf");
    expect(run.output).toContain("selected: 1 of 2 test files");
    expect(run.output).toMatch(/^ {2}packages\/top\/src\/top\.test\.ts$/m);
    expect(run.output).not.toMatch(/^ {2}packages\/other\/src\/other\.test\.ts$/m);
    expect(run.code, run.output).toBe(0);
  });

  test("the root manifest selects the whole suite, past a cap of one", async () => {
    await write("packages/leaf/package.json", JSON.stringify({ name: "@probe/leaf", type: "module", exports: { ".": "./src/index.ts" } }));
    await write("package.json", JSON.stringify({ name: "probe", private: true, workspaces: ["packages/*"] }));
    const run = await runCli("main", "--list", "--cap", "1");
    expect(run.output).toContain("selected: the whole suite (2 test files)");
    expect(run.output).not.toContain("selection capped");
    expect(run.code, run.output).toBe(0);
  });
});

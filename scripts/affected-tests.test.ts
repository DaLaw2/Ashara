import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { boundSelection, parseNameStatus, repositorySources, selectTests, SIMULATOR_DIR, WHOLE_SUITE_RULES, type BoundedRun, type ChangedPath, type Selection, type SelectionSources } from "./affected-tests.js";

const REPO = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(import.meta.dirname, "affected-tests.ts");
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

/** A stub whose batch read is its single-file read, file by file, unless `over` states one. */
function stubSources(over: Partial<SelectionSources> = {}): SelectionSources {
  const stub: Omit<SelectionSources, "readRevisions"> = {
    allTests: ["packages/a/src/a.test.ts", `${SIMULATOR_DIR}one.test.ts`, `${SIMULATOR_DIR}two.test.ts`, "packages/integration/src/workplace/snap.test.ts"],
    testsImporting: () => Promise.resolve(["packages/a/src/a.test.ts"]),
    filesNaming: () => [],
    files: [],
    readRevision: () => undefined,
    ...over,
  };
  return { readRevisions: (files, side) => new Map(files.map((file) => [file, stub.readRevision(file, side)])), ...stub, ...over };
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

/** Whether `run` runs every test file `selection` selects: the whole suite, or a superset of its tests. */
function runCovers(selection: Selection, run: BoundedRun): boolean {
  if (selection.kind === "whole-suite") return run.kind === "whole-suite";
  if (run.kind === "whole-suite") return true;
  if (run.kind === "nothing") return selection.tests.length === 0;
  const ran = new Set(run.tests);
  return selection.tests.every((t) => ran.has(t));
}

describe("the run of a selection", () => {
  const CORE = "packages/a/src/core.ts";
  const COLOCATED = "packages/a/src/core.test.ts";
  const IMPORTER = "packages/b/src/b.test.ts";
  const TRANSITIVE = ["packages/c/src/c1.test.ts", "packages/c/src/c2.test.ts", "packages/c/src/c3.test.ts", "packages/c/src/c4.test.ts", "packages/c/src/c5.test.ts"];
  const ALL = [COLOCATED, IMPORTER, ...TRANSITIVE, "packages/d/src/unrelated.test.ts"];

  // core.ts is imported by its colocated test and b.test.ts directly, and by the c tests through b.
  const graph = stubSources({
    allTests: ALL,
    testsImporting: (modules) => Promise.resolve(modules.includes(CORE) ? [COLOCATED, IMPORTER, ...TRANSITIVE] : []),
  });

  test("a related set no larger than the large mark runs whole, with no notice", async () => {
    const run = boundSelection(await selectTests([modified(CORE)], graph), ALL.length, { largeSelection: 10 });
    expect(run).toEqual({ kind: "tests", tests: [COLOCATED, ...TRANSITIVE, IMPORTER].sort(), notice: undefined });
  });

  test("a related set past the large mark still runs every selected test file, and says it is large", async () => {
    const run = boundSelection(await selectTests([modified(CORE)], graph), ALL.length, { largeSelection: 3 });
    expect(run).toEqual({
      kind: "tests",
      tests: [COLOCATED, ...TRANSITIVE, IMPORTER].sort(),
      notice: "a large selection: 7 test files, more than 3; every one of them runs, which may take as long as the full suite",
    });
  });

  test("a whole-suite verdict runs the whole suite at any size, and says so", async () => {
    const selection = await selectTests([modified(CORE), modified("migrations/added.sql")], graph);
    expect(selection.kind).toBe("whole-suite");
    for (const largeSelection of [1, 3, 8, 100]) {
      expect(boundSelection(selection, ALL.length, { largeSelection })).toEqual({ kind: "whole-suite", count: 8, notice: "runs the whole suite: every one of its 8 test files" });
    }
  });

  test("a source change that selects no test fails the run; a change that touches no source passes it; a migration runs the whole suite", async () => {
    const orphan = boundSelection(await selectTests([modified("packages/d/src/orphan.ts")], graph), ALL.length, { largeSelection: 10 });
    expect(orphan).toMatchObject({ kind: "nothing", exitCode: 1 });
    const migration = boundSelection(await selectTests([modified("migrations/added.sql")], graph), ALL.length, { largeSelection: 3 });
    expect(migration).toMatchObject({ kind: "whole-suite", count: ALL.length });
    const docs = boundSelection(await selectTests([modified("README.md")], graph), ALL.length, { largeSelection: 10 });
    expect(docs).toMatchObject({ kind: "nothing", exitCode: 0 });
  });

  test("a large mark that is not a positive whole number is refused", async () => {
    const selection = await selectTests([modified(CORE)], graph);
    expect(() => boundSelection(selection, ALL.length, { largeSelection: 0 })).toThrow(/not a positive whole number/);
  });

  test("every selection's run covers every test file it selects, at any size, and no notice reports a skip", async () => {
    const changes: ChangedPath[][] = [
      [modified(CORE)],
      [modified(CORE), modified("migrations/added.sql")],
      [modified(CORE), modified("packages/b/src/b.test.ts")],
      [modified("packages/b/src/b.test.ts")],
      [modified("packages/d/src/orphan.ts")],
      [modified("README.md")],
      [modified("boundary-rules.toml")],
      [modified("vitest.config.mts")],
    ];
    for (const change of changes) {
      const selection = await selectTests(change, graph);
      for (const largeSelection of [1, 2, 3, 7, 8, 100]) {
        const run = boundSelection(selection, ALL.length, { largeSelection });
        const label = `${change.map((c) => c.path).join(", ")} at ${largeSelection}`;
        expect(runCovers(selection, run), label).toBe(true);
        expect(run.notice ?? "", label).not.toMatch(/skip/);
        if (selection.kind === "selected" && selection.tests.length > largeSelection) expect(run.notice, label).toMatch(/^a large selection: \d+ test files, more than \d+; every one of them runs/);
        if (selection.kind === "whole-suite") expect(run.notice, label).toBe(`runs the whole suite: every one of its ${ALL.length} test files`);
      }
    }
  });

  test("affected-tests.ts holds no cap and no direct-only trim that drops selected tests", async () => {
    const source = await readFile(SCRIPT, "utf-8");
    expect(source).not.toContain("skipped; the merge lane");
    expect(source).not.toMatch(/selection\.direct|direct test file|maxTests|capped|--cap|past the cap|testsImportingDirectly/);
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
  const USES_A = "packages/b/src/uses-a.ts";
  const PLAIN = "export const plain = 1;\n";
  const TEXTS = new Map([
    [HONO_IMPORTER, 'import { Hono } from "hono";\nexport const app = new Hono();\n'],
    [USES_A, 'import { start } from "@p/a";\nexport const run = start;\n'],
  ]);

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

  // Every file has a text: a module or test the stub could not read would fail closed to its workspace.
  // `texts` overrides a file's text; an undefined entry is a file whose text cannot be read.
  const sources = (base: string | undefined, head: string | undefined, texts = new Map<string, string | undefined>(), extraFiles: readonly string[] = []): SelectionSources => {
    const files = [...ALL, A_MODULE, HONO_IMPORTER, USES_A, "packages/c/src/plain.ts", "package.json", "package-lock.json", ...extraFiles];
    const textOf = (file: string): string | undefined => {
      if (file === "package-lock.json") return head;
      if (texts.has(file)) return texts.get(file);
      return TEXTS.get(file) ?? PLAIN;
    };
    return stubSources({
      allTests: ALL,
      files,
      readRevision: (file, side) => (file === "package-lock.json" && side === "base" ? base : textOf(file)),
      // A plain text search, as the repository's is.
      filesNaming: (name) => files.filter((file) => textOf(file)?.includes(name) === true),
      testsImporting: (modules) =>
        Promise.resolve([...(modules.includes(A_MODULE) ? [IMPORTS_A] : []), ...(modules.includes(HONO_IMPORTER) ? [IMPORTS_HONO] : [])]),
    });
  };

  const upgrade = [modified("packages/a/package.json"), modified("package-lock.json")];

  test("a hono upgrade in a workspace manifest and the lockfile selects every test of each workspace that resolves it, and the tests that reach them", async () => {
    const selection = await selectTests(upgrade, sources(lockfile("4.0.0"), lockfile("4.1.0")));
    if (selection.kind !== "selected") throw new Error(`expected a selection, got the whole suite: ${selection.reasons.join("; ")}`);
    const expected = [...TESTS.a, ...TESTS.b, IMPORTS_A, IMPORTS_HONO].sort();
    expect(selection.tests).toEqual(expected);
    expect(selection.tests).not.toContain("packages/c/src/c2.test.ts");
    expect(selection.tests).not.toContain("scripts/s2.test.ts");
  });

  test("a dependency change's tests all run beside a module change, however many they are", async () => {
    const selection = await selectTests([modified("packages/c/src/plain.ts"), ...upgrade], sources(lockfile("4.0.0"), lockfile("4.1.0")));
    const run = boundSelection(selection, ALL.length, { largeSelection: 1 });
    if (run.kind !== "tests") throw new Error(`expected a test run, got ${run.kind}`);
    expect(run.tests).toEqual([...TESTS.a, ...TESTS.b, IMPORTS_A, IMPORTS_HONO].sort());
    expect(run.notice).toBe("a large selection: 6 test files, more than 1; every one of them runs, which may take as long as the full suite");
  });

  test("a selection past the large mark says it is large, never that any file was skipped", async () => {
    const selection = await selectTests(upgrade, sources(lockfile("4.0.0"), lockfile("4.1.0")));
    const run = boundSelection(selection, ALL.length, { largeSelection: 1 });
    if (run.kind !== "tests") throw new Error(`expected a test run, got ${run.kind}`);
    expect(run.tests).toHaveLength(6);
    expect(run.notice).not.toMatch(/skip/);
  });

  // One path per whole-suite rule; a rule added without a path here fails the check below.
  const WHOLE_SUITE_BESIDE_DEPENDENCY = [
    "migrations/zzzz_probe.sql",
    "boundary-rules.toml",
    "eslint.config.mjs",
    "tsconfig.json",
    "vitest.config.mts",
    "packages/integration/src/cell-leak-guard.ts",
    "packages/integration/src/podman-test-load.ts",
    "config/probe.toml",
  ];

  test("every whole-suite rule has a probe path", () => {
    for (const rule of WHOLE_SUITE_RULES) expect(WHOLE_SUITE_BESIDE_DEPENDENCY.some((f) => rule.pattern.test(f)), rule.pattern.source).toBe(true);
  });

  test.each(WHOLE_SUITE_BESIDE_DEPENDENCY)("a whole-suite path (%s) beside a dependency change runs the whole suite, which holds the dependency change's tests", async (file) => {
    const head = lockfile("4.0.0", { "node_modules/hono": { version: "4.0.0-probe", dependencies: { tiny: "1.0.0" } } });
    const selection = await selectTests([modified("package-lock.json"), modified(file)], sources(lockfile("4.0.0"), head));
    expect(selection).toMatchObject({ kind: "whole-suite" });
    expect(selection.reasons.join("\n")).toMatch(/^package-lock\.json: /m);
    expect(boundSelection(selection, ALL.length, { largeSelection: 1 })).toEqual({ kind: "whole-suite", count: ALL.length, notice: `runs the whole suite: every one of its ${ALL.length} test files` });
  });

  test("a nested copy resolves to the workspaces that resolve its parent, and to every module that imports the parent by name", async () => {
    const base = lockfile("4.0.0");
    const head = lockfile("4.0.0", { "node_modules/hono/node_modules/tiny": { version: "1.0.1" } });
    const selection = await selectTests([modified("package-lock.json")], sources(base, head));
    expect(selection).toMatchObject({ kind: "selected", tests: [...TESTS.a, ...TESTS.b, IMPORTS_A, IMPORTS_HONO].sort() });
  });

  const DYNAMIC_LOADER = "packages/c/src/loader.ts";
  const IMPORTS_LOADER = "packages/c/src/c2.test.ts";
  const loaderSources = (loaderText: string | undefined, loader = DYNAMIC_LOADER): SelectionSources => {
    const base = sources(lockfile("4.0.0"), lockfile("4.1.0"), new Map([[loader, loaderText]]), [loader, "packages/a/package.json", "packages/b/package.json", "packages/c/package.json"]);
    return { ...base, testsImporting: async (modules) => [...(await base.testsImporting(modules)), ...(modules.includes(DYNAMIC_LOADER) ? [IMPORTS_LOADER] : [])] };
  };
  const honoUpgrade = [modified("package-lock.json")];
  const HONO_SELECTION = [...TESTS.a, ...TESTS.b, IMPORTS_A, IMPORTS_HONO];

  test.each([
    ["a comment", '// import { Hono } from "hono";\n/* const late = await import(target); require("hono/jsx") */\nexport const quiet = 1;\n'],
    ["a string literal", 'export const doc = \'import { Hono } from "hono"; import(target); require(`hono/${x}`)\';\n'],
  ])("%s that spells an import is no import edge, and selects nothing more", async (_name, text) => {
    const selection = await selectTests(honoUpgrade, loaderSources(text));
    expect(selection).toMatchObject({ kind: "selected", tests: [...HONO_SELECTION].sort() });
    expect(selection.reasons.join("\n")).not.toContain(DYNAMIC_LOADER);
  });

  test.each([
    ["an import( split across lines", "export const load = (x: string) => import\n(`hono/${x}`);\n"],
    ["a require of a template", "export const load = (x: string): unknown => require(`hono/${x}`);\n"],
    ["a require", 'const hono: unknown = require("hono");\nexport { hono };\n'],
    ["an import-equals require", 'import hono = require("hono");\nexport { hono };\n'],
    ["an export-from", 'export * from "hono";\n'],
    ["an export-from of a subpath", "export { jsx } from 'hono/jsx';\n"],
  ])("%s of a changed package selects the importer's dependants, and the reasons name it", async (_name, text) => {
    const selection = await selectTests(honoUpgrade, loaderSources(text));
    expect(selection).toMatchObject({ kind: "selected", tests: [...HONO_SELECTION, IMPORTS_LOADER].sort() });
    expect(selection.reasons).toContain(`hono: 2 module(s) and test(s) import it by name (${DYNAMIC_LOADER}, ${HONO_IMPORTER}); they and their graph dependants run`);
  });

  test("a template-literal import whose static prefix is a changed scoped package's scope selects the importer's dependants", async () => {
    const selection = await selectTests([modified("packages/a/package.json")], loaderSources("export const load = (x: string) => import(`@p/${x}`);\n"));
    expect(selection).toMatchObject({ kind: "selected", tests: [...TESTS.a, ...TESTS.b, IMPORTS_A, IMPORTS_LOADER].sort() });
    expect(selection.reasons).toContain(`@p/a: 2 module(s) and test(s) import it by name (${USES_A}, ${DYNAMIC_LOADER}); they and their graph dependants run`);
  });

  test("a lockfile-only change to a workspace's own entry selects the modules that import that workspace's package by name", async () => {
    const asked: string[] = [];
    const head = lockfile("4.0.0", { "packages/a": { name: "@p/a", version: "0.0.1", dependencies: { hono: "4.0.0" } } });
    const base = sources(lockfile("4.0.0"), head);
    const selection = await selectTests([modified("package-lock.json")], {
      ...base,
      testsImporting: (modules) => {
        asked.push(...modules);
        return base.testsImporting(modules);
      },
    });
    expect(asked).toContain(USES_A);
    expect(selection).toMatchObject({ kind: "selected", tests: [...TESTS.a, ...TESTS.b, IMPORTS_A].sort() });
    expect(selection.reasons).toContain(`@p/a: 1 module(s) and test(s) import it by name (${USES_A}); they and their graph dependants run`);
  });

  test("a template-literal dynamic import whose static prefix names a changed package selects the importer's dependants", async () => {
    const selection = await selectTests(honoUpgrade, loaderSources("export const load = (x: string) => import(`hono/${x}`);\n"));
    expect(selection).toMatchObject({ kind: "selected", tests: [...HONO_SELECTION, "packages/c/src/c2.test.ts"].sort() });
  });

  test("a template-literal dynamic import of another package or a relative module selects nothing more", async () => {
    for (const text of ["import(`honorific/${x}`);", "import(`./plugins/${x}.js`);", "import(`node:${x}`);"]) {
      const selection = await selectTests(honoUpgrade, loaderSources(text));
      expect(selection, text).toMatchObject({ kind: "selected", tests: [...HONO_SELECTION].sort() });
    }
  });

  test.each([
    ["a computed specifier", "export const load = (target: string) => import(target);\n", "an import whose target is computed may load any package"],
    ["a computed specifier split across lines", "export const load = (target: string) => import\n(target);\n", "an import whose target is computed may load any package"],
    ["a computed require", "export const load = (target: string): unknown => require(target);\n", "an import whose target is computed may load any package"],
    ["a template with no static prefix", "export const load = (x: string) => import(`${x}/index.js`);\n", "an import whose template target begins `` may load any package"],
    ["a loader whose text cannot be read", undefined, "its text cannot be read to see what it imports"],
  ])("a dynamic import with %s fails closed to every test of the importer's workspace, and the reasons say so", async (_name, text, why) => {
    const selection = await selectTests(honoUpgrade, loaderSources(text));
    expect(selection).toMatchObject({ kind: "selected", tests: [...new Set([...HONO_SELECTION, ...TESTS.c])].sort() });
    expect(selection.reasons).toContain(`${DYNAMIC_LOADER}: ${why}, so every module and test of workspace packages/c runs`);
  });

  test("a computed dynamic import outside every workspace manifest fails closed to the root project's own files", async () => {
    const selection = await selectTests(honoUpgrade, loaderSources("await import(target);\n", "scripts/loader.ts"));
    expect(selection).toMatchObject({ kind: "selected", tests: [...new Set([...HONO_SELECTION, ...TESTS.root])].sort() });
    expect(selection.reasons).toContain("scripts/loader.ts: an import whose target is computed may load any package, so every module and test of the root project's files outside every workspace runs");
  });

  test.each([
    ["an entry the root project resolves", lockfile("4.0.0"), lockfile("4.0.0", { "node_modules/zod": { version: "4.1.0" } }), /root project resolves node_modules\/zod/],
    ["an entry no workspace resolves", lockfile("4.0.0"), lockfile("4.0.0", { "node_modules/orphan": { version: "1.0.0" } }), /no workspace resolves node_modules\/orphan/],
    ["a lockfile absent at the base", undefined, lockfile("4.0.0"), /absent at the base/],
    ["a file that differs with no entry differing", lockfile("4.0.0"), lockfile("4.0.0"), /no locked entry does/],
  ])("%s selects the whole suite, which runs whole", async (_name, base, head, reason) => {
    const selection = await selectTests([modified("package-lock.json")], sources(base, head));
    expect(selection).toMatchObject({ kind: "whole-suite" });
    expect(selection.reasons.join("\n")).toMatch(reason);
    expect(boundSelection(selection, ALL.length, { largeSelection: 1 })).toMatchObject({ kind: "whole-suite", count: ALL.length });
  });

  test("the root manifest, the vitest config and a migration each run the whole suite", async () => {
    for (const file of ["package.json", "vitest.config.mts", "migrations/added.sql"]) {
      const selection = await selectTests([modified(file)], sources(lockfile("4.0.0"), lockfile("4.0.0")));
      expect(boundSelection(selection, ALL.length, { largeSelection: 1 }), file).toMatchObject({ kind: "whole-suite", count: ALL.length });
    }
  });

  test("a manifest outside the workspaces the lockfile records selects the whole suite", async () => {
    const selection = await selectTests([modified("packages/z/package.json")], sources(lockfile("4.0.0"), lockfile("4.0.0")));
    expect(selection).toMatchObject({ kind: "whole-suite" });
  });

  test("a malformed head lockfile is never read for a change that touches no manifest or lockfile", async () => {
    const reads: string[] = [];
    const base = sources(lockfile("4.0.0"), "{ not a lockfile");
    const selection = await selectTests([modified("packages/c/src/plain.ts")], {
      ...base,
      readRevision: (file, side) => {
        reads.push(`${file}@${side}`);
        return base.readRevision(file, side);
      },
      readRevisions: (files, side) => {
        reads.push(...files.map((file) => `${file}@${side}`));
        return base.readRevisions(files, side);
      },
    });
    expect(selection.kind).toBe("selected");
    expect(reads.filter((read) => read.startsWith("package-lock.json"))).toEqual([]);
  });

  test("a malformed head lockfile fails the selection when a workspace manifest changed", async () => {
    await expect(selectTests([modified("packages/a/package.json")], sources(lockfile("4.0.0"), "{ not a lockfile"))).rejects.toThrow(/package-lock\.json at the head/);
  });

  test("the reasons name what the header says they name: each selected workspace, every importer by name, and each file that brings its workspace", async () => {
    const header = (await readFile(SCRIPT, "utf-8")).replace(/\n \*\s*/g, " ");
    expect(header).toContain(
      "The reasons name each selected workspace (in the changed manifest's or lockfile's line), every module and test that imports a changed package by name (in that package's line), and each file whose target no static prefix bounds or whose text cannot be read, with the workspace it brings; the files a workspace holds and the graph dependants are counted in the selection, not named.",
    );
    const selection = await selectTests(honoUpgrade, loaderSources("export const load = (target: string) => import(target);\n"));
    const reasons = selection.reasons.join("\n");
    expect(reasons).toMatch(/^package-lock\.json: .*selects every test of 2 workspace\(s\) \(packages\/a, packages\/b\)/m);
    expect(reasons).toContain(`hono: 1 module(s) and test(s) import it by name (${HONO_IMPORTER})`);
    expect(reasons).toContain(`${DYNAMIC_LOADER}: an import whose target is computed may load any package, so every module and test of workspace packages/c runs`);
    // Every file a reason names is an importer by name (hono's, and @p/a's whose lockfile entry changed) or the file that brought its workspace.
    expect(new Set(reasons.match(/[\w./-]+\.(?:ts|mjs|js)\b/g))).toEqual(new Set([HONO_IMPORTER, USES_A, DYNAMIC_LOADER]));
  });

  test("a lockfile not of the npm shape fails the selection", async () => {
    await expect(selectTests([modified("package-lock.json")], sources(lockfile("4.0.0"), '{"packages": []}'))).rejects.toThrow(/package-lock\.json at the head/);
  });
});

describe("the import edges selection reads", () => {
  test("affected-tests.ts reads no import edge by a text search: its only name search is for a changed file's name", async () => {
    const source = await readFile(SCRIPT, "utf-8");
    expect(source).not.toMatch(/matchAll|DYNAMIC_IMPORT_RE|IMPORT_SPECIFIER_RE|specifierSpellings/);
    expect(source.match(/\bfilesNaming\([^)]*\)/g)).toEqual(["filesNaming(path.posix.basename(file)"]);
  });
});

describe("this repository's graph", () => {
  test("a revision's files are read together, byte for byte as git holds them, and a file it lacks reads as absent", async () => {
    const sources = await repositorySources(REPO, { base: "HEAD", head: "HEAD" });
    try {
      // connection.ts holds non-ASCII text, so a byte count read as a character count would cut it.
      const files = ["packages/db/src/connection.ts", "scripts/affected-tests.ts", "no/such/module.ts"];
      const texts = sources.readRevisions(files, "head");
      for (const file of files.slice(0, 2)) expect(texts.get(file), file).toBe(execFileSync("git", ["show", `HEAD:${file}`], { cwd: REPO, encoding: "utf-8" }));
      expect(texts.has("no/such/module.ts")).toBe(true);
      expect(texts.get("no/such/module.ts")).toBeUndefined();
      expect(sources.readRevision("scripts/affected-tests.ts", "base")).toBe(texts.get("scripts/affected-tests.ts"));
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
    const run = await runCli("main", "--list");
    expect(run.output).toContain("packages/leaf/package.json: the manifest of workspace packages/leaf");
    expect(run.output).toContain("selected: 1 of 2 test files");
    expect(run.output).toMatch(/^ {2}packages\/top\/src\/top\.test\.ts$/m);
    expect(run.output).not.toMatch(/^ {2}packages\/other\/src\/other\.test\.ts$/m);
    expect(run.code, run.output).toBe(0);
  });

  test("the root manifest selects the whole suite, and the run says it runs every test file", async () => {
    await write("packages/leaf/package.json", JSON.stringify({ name: "@probe/leaf", type: "module", exports: { ".": "./src/index.ts" } }));
    await write("package.json", JSON.stringify({ name: "probe", private: true, workspaces: ["packages/*"] }));
    const run = await runCli("main", "--list");
    expect(run.output).toContain("selected: the whole suite (2 test files)");
    expect(run.output).toContain("runs the whole suite: every one of its 2 test files");
    expect(run.output).not.toMatch(/skip/);
    expect(run.code, run.output).toBe(0);
  });
});

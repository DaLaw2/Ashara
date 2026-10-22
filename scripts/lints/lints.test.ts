import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { run as languageHomes } from "./language-homes.js";
import { loadLintContext, type LintContext, type PackageScan } from "./lint.js";
import { run as projectRecord } from "./project-record.js";
import { run as recognisedWording } from "./recognised-wording.js";
import { parseRules } from "./rules.js";

const REPO = path.join(import.meta.dirname, "..", "..");
const LINTS_DIR = import.meta.dirname;
const RUNNER = path.join(REPO, "scripts", "check-boundaries.ts");

/** Lint modules hold one lint each; these are the shared readers and helpers the lints build on. */
const HELPERS = new Set(["lint.ts", "module-rules.ts", "rules.ts", "rules-parse-error.ts", "source-files.ts", "stand-ins.ts"]);

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

const PROJECT_RECORD = `export const projects = pgTable("projects", {
  id: uuid().primaryKey(),
  name: text().notNull(),
  lifecycle: varchar({ length: 20 }).notNull(),
  clientId: uuid("client_id").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  workspacePath: text("workspace_path"),
EXTRA});
`;

/** A tree holding the project schema (with `extra` columns) and one delivery file of `source`. */
function projectRecordTree(extra: string, source: string): LintContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-record-"));
  scratch = root;
  const schema = path.join(root, "packages", "db", "src", "schema", "project.ts");
  fs.mkdirSync(path.dirname(schema), { recursive: true });
  fs.writeFileSync(schema, PROJECT_RECORD.replace("EXTRA", extra));
  const pkgRoot = path.join(root, "packages", "delivery");
  const file = path.join(pkgRoot, "src", "repo.ts");
  const rule = parseRules("[delivery]\nallow = []\n", "boundary-rules.toml").get("delivery");
  if (rule === undefined) throw new Error("the delivery rule did not parse");
  return {
    root,
    packagesDir: path.join(root, "packages"),
    rulesRelative: "boundary-rules.toml",
    toml: "",
    rules: new Map(),
    packageDirs: ["db", "delivery"],
    packages: [{ name: "delivery", rule, root: pkgRoot, contents: new Map([[file, source]]), relativeTo: (f: string) => path.relative(pkgRoot, f) }],
  };
}

describe("project-record", () => {
  test("the project record with its identity, workspace and lifecycle alone, read by no foreign field, is clean", () => {
    expect(projectRecord(projectRecordTree("", "select({ id: projects.id, lifecycle: projects.lifecycle })\n"))).toEqual([]);
  });

  test("a per-context column declared on projects is a violation", () => {
    const violations = projectRecord(projectRecordTree('  planAttempts: integer("plan_attempts").notNull(),\n', ""));
    expect(violations.map((v) => v.file)).toEqual([path.join("packages", "db", "src", "schema", "project.ts")]);
  });

  test("a planning, halt-cause or fault field read on projects outside the schema is a violation", () => {
    const source = "const a = projects.planAttempts;\nsql`SELECT 1 FROM projects WHERE projects.blocked_reason IS NULL`;\nconst c = projects.acceptanceFaults;\n";
    const violations = projectRecord(projectRecordTree("", source));
    expect(violations.map((v) => `${v.line} ${v.specifier}`)).toEqual(["1 projects.planAttempts", "2 projects.blocked_reason", "3 projects.acceptanceFaults"]);
  });

  test("a missing project schema fails closed", () => {
    const context = projectRecordTree("", "");
    fs.rmSync(path.join(context.root, "packages", "db", "src", "schema", "project.ts"));
    expect(projectRecord(context)).toHaveLength(1);
  });

  test("the repository's project record holds no per-context state", () => {
    expect(projectRecord(loadLintContext(REPO))).toEqual([]);
  });
});

function emptyRule(name: string): PackageScan["rule"] {
  const rule = parseRules(`[${name}]\nallow = []\n`, "boundary-rules.toml").get(name);
  if (rule === undefined) throw new Error(`the ${name} rule did not parse`);
  return rule;
}

/** A tree of in-memory packages, each a map of its src-relative files, under a [homes] section. */
function homesTree(homes: string, packages: Readonly<Record<string, Readonly<Record<string, string>>>>): LintContext {
  const scans = Object.entries(packages).map(([name, files]): PackageScan => {
    const pkgRoot = `/repo/packages/${name}`;
    return {
      name,
      rule: emptyRule(name),
      root: pkgRoot,
      contents: new Map(Object.entries(files).map(([file, text]) => [`${pkgRoot}/src/${file}`, text])),
      relativeTo: (filePath) => filePath.slice(pkgRoot.length + 1),
    };
  });
  return { root: "/repo", packagesDir: "/repo/packages", rulesRelative: "boundary-rules.toml", toml: `[homes]\n${homes}\n`, rules: new Map(), packageDirs: Object.keys(packages), packages: scans };
}

describe("language-homes", () => {
  const HOME = { "plan.ts": "export type WorkPlan = { readonly kind: \"substrate\" };\n" };

  test("a name declared only at its home is clean, and a test elsewhere may name it", () => {
    const context = homesTree(`WorkPlan = "delivery"`, { delivery: HOME, quality: { "x.test.ts": "type WorkPlan = string;\n" } });
    expect(languageHomes(context)).toEqual([]);
  });

  test("a copy in another package, and a re-export shim, are violations", () => {
    const context = homesTree(`WorkPlan = "delivery"`, {
      delivery: HOME,
      quality: {
        "result.ts": "import x from \"y\";\nexport type WorkPlan =\n  | { readonly kind: \"substrate\" };\n",
        "index.ts": "export type {\n  AgentWork,\n  WorkPlan,\n} from \"./result.js\";\n",
      },
    });
    expect(languageHomes(context).map((v) => `${v.file}:${v.line}`).sort()).toEqual(["packages/quality/src/index.ts:3", "packages/quality/src/result.ts:2"]);
  });

  test("a name its home does not declare is a stale entry", () => {
    const context = homesTree(`WorkPlan = "delivery"`, { delivery: {}, quality: {} });
    expect(languageHomes(context).map((v) => `${v.file}:${v.line}`)).toEqual(["boundary-rules.toml:2"]);
  });

  test("an entry naming no package refuses the gate", () => {
    expect(() => languageHomes(homesTree(`WorkPlan = "nowhere"`, { delivery: HOME }))).toThrow(/names no package/);
  });

  test("the repository declares every name of [homes] at its home only", () => {
    expect(languageHomes(loadLintContext(REPO))).toEqual([]);
  });
});

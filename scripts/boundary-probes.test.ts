/**
 * Negative probes for boundary-rules.toml (ADR-075 context map), run against the real checker.
 *
 * The map below is the expected side: for every package it states the packages it may import, the
 * packages that admit only some importers, and the files a restricted edge is confined to. The test
 * copies packages/, the rules and the checker into a scratch tree, plants one violating import per
 * forbidden package pair, per restrict rule, for the named-only rule, for the stand-in rule
 * (directly and through a helper) and for the bounds-table rule (a package's name and another
 * file), one manifest-name literal in production source for the
 * [stack-literals] denylist, plus one permitted import
 * per allowed edge, runs scripts/check-boundaries.ts there and asserts it reports exactly the
 * violations the map predicts. So a rule that stops firing fails, and so does an edge widened or
 * narrowed in the rules file without changing the map here.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

interface PackageMap {
  /** Packages this one may import; "*" for the composition root. */
  readonly allow: readonly string[] | "*";
  /** The only packages that may import this one, when the map confines it. */
  readonly importers?: readonly string[];
  /** importedPkg -> the package-relative globs that alone may import it. */
  readonly restrict?: Readonly<Record<string, readonly string[]>>;
}

const ACL = ["src/acl/*.ts"];
const ACL_AND_DISPATCH = ["src/acl/*.ts", "src/dispatch/*.ts"];

const MAP: Readonly<Record<string, PackageMap>> = {
  shared: { allow: [] },
  db: { allow: ["shared"] },
  "model-access": { allow: ["shared"], importers: ["finance", "server", "integration"] },
  finance: { allow: ["shared", "db", "model-access"] },
  security: { allow: ["db"], importers: ["server", "integration"] },
  "execution-infra": { allow: ["shared"] },
  knowledge: { allow: ["shared", "db"] },
  workplace: { allow: ["shared", "db", "finance", "execution-infra"] },
  engagement: {
    allow: ["shared", "db", "finance", "delivery"],
    restrict: {
      delivery: [
        "src/answers.ts",
        "src/block-report.ts",
        "src/intake.ts",
        "src/plan-report.ts",
        "src/plan-report.test.ts",
        "src/repositories/block-report.ts",
        "src/repositories/delivered-report.ts",
        "src/stack-choice.ts",
      ],
    },
  },
  organization: {
    allow: ["shared", "finance", "engagement", "workplace"],
    restrict: { engagement: ACL, workplace: ACL },
  },
  quality: {
    allow: ["shared", "db", "finance", "execution-infra", "workplace", "delivery", "engagement"],
    restrict: { delivery: ACL, engagement: ACL },
  },
  delivery: {
    allow: ["shared", "db", "engagement", "organization", "workplace", "quality", "knowledge", "execution-infra", "finance"],
    restrict: {
      engagement: ACL,
      organization: ACL,
      workplace: ACL_AND_DISPATCH,
      quality: ACL_AND_DISPATCH,
      knowledge: ACL_AND_DISPATCH,
      "execution-infra": ACL_AND_DISPATCH,
      finance: ACL_AND_DISPATCH,
    },
  },
  server: {
    allow: "*",
    restrict: { security: ["src/compose.ts", "src/secrets.ts", "src/secrets.test.ts", "src/web-client.ts"] },
  },
  integration: {
    allow: ["shared", "db", "model-access", "finance", "security", "execution-infra", "knowledge", "workplace", "engagement", "organization", "quality", "delivery", "server"],
    importers: [],
  },
};

const NAMED_ONLY_PROBE = {
  file: "packages/integration/src/simulator/__boundary_probe__.ts",
  content: 'import { NotAListedName } from "@ashara/shared";\n',
  violation: 'packages/integration/src/simulator/__boundary_probe__.ts:1  integration -> "@ashara/shared"  (named-only file: "NotAListedName" is not in names.shared)',
};

const STACK_LITERAL_PROBE = {
  file: "packages/delivery/src/__boundary_probe__/stack-literal.ts",
  content: 'export const MANIFEST = "Cargo.toml";\n',
  violation:
    'packages/delivery/src/__boundary_probe__/stack-literal.ts:1  delivery -> "Cargo.toml"  (stack literal in production source: "Cargo.toml"; take it from the contract, or exempt it in [stack-literals] with a reason)',
};

// A stand-in model importing a product rule (a name names.delivery lists, so only the stand-in list
// refuses it), directly, through a simulator helper that re-exports one, and by a relative path into
// the package that owns it.
const STAND_IN = "packages/integration/src/simulator/scripted-models.ts";
const STAND_IN_HELPER = "packages/integration/src/simulator/__boundary_probe_helper__.ts";
const STAND_IN_PROBES = [
  {
    name: "a stand-in model imports no product rule",
    file: STAND_IN,
    content: 'import { parseStoredTaskSpec } from "@ashara/delivery";\nimport { probedRule } from "./__boundary_probe_helper__.js";\n',
    violation: `${STAND_IN}:1  integration -> "@ashara/delivery"  (stand-in model file: "parseStoredTaskSpec" is not in stand-in-names.delivery)`,
    prepend: true,
  },
  {
    name: "a named-only file reaches no other package by a relative path",
    file: "packages/integration/src/simulator/__boundary_probe_escape__.ts",
    content: 'import { parseStoredTaskSpec } from "../../../delivery/src/index.js";\n',
    violation:
      'packages/integration/src/simulator/__boundary_probe_escape__.ts:1  integration -> "../../../delivery/src/index.js"  ' +
      "(named-only file: the relative import leaves the package; import another package by its @ashara/ name)",
  },
  {
    name: "a stand-in model is handed no product rule by a helper",
    file: STAND_IN_HELPER,
    content: 'export { parseStoredBlockedReason as probedRule } from "@ashara/delivery";\n',
    violation:
      `${STAND_IN_HELPER}:1  integration -> "@ashara/delivery"  ` +
      "(reached by a value import from stand-in src/simulator/scripted-models.ts: \"parseStoredBlockedReason\" is not in stand-in-names.delivery)",
  },
];

// The oracle's bounds table importing a production bound, by name (a name names.workplace lists, so
// only the bounds-table rule refuses it) and through another simulator file.
const BOUNDS_TABLE = "packages/integration/src/simulator/work-bounds.ts";
const BOUNDS_TABLE_PROBES = [
  {
    name: "the oracle's bounds table imports no production bound",
    file: BOUNDS_TABLE,
    content: 'import { CHECK_MISSING_EXIT } from "@ashara/workplace";\nimport { PROFILES } from "./profile.js";\n',
    violation: `${BOUNDS_TABLE}:1  integration -> "@ashara/workplace"  (bounds-table file: it imports nothing from another package; each bound cites its decision instead)`,
    prepend: true,
  },
  {
    // Planted by the probe above, on its second line: this entry adds nothing to the file.
    name: "the oracle's bounds table imports no other file",
    file: BOUNDS_TABLE,
    content: "",
    violation: `${BOUNDS_TABLE}:2  integration -> "./profile.js"  (bounds-table file: it imports no other file, which could hand it a production constant)`,
    prepend: true,
  },
];

const REPO = path.resolve(import.meta.dirname, "..");
const PROBE_DIR = "src/__boundary_probe__";

class ProbeTreeError extends Error {
  constructor(readonly operation: string, readonly detail: string) {
    super(`boundary probes: ${operation}: ${detail}`);
    this.name = "ProbeTreeError";
  }
}

interface PlannedProbe {
  readonly name: string;
  readonly file: string;
  readonly content: string;
  /** The checker's report line for it; null for a permitted import, which must report nothing. */
  readonly violation: string | null;
  /** Planted at the head of an existing file, which the clean run passed, so it is reported at :1. */
  readonly prepend?: boolean;
}

function reportLine(file: string, fromPkg: string, toPkg: string, reason: string): string {
  return `${file}:1  ${fromPkg} -> "@ashara/${toPkg}"  (${reason})`;
}

function plannedProbes(packages: readonly string[]): PlannedProbe[] {
  const probes: PlannedProbe[] = [];
  for (const from of packages) {
    const rule = MAP[from];
    for (const to of packages) {
      if (to === from) continue;
      const importers = MAP[to].importers;
      const refusedByImporters = importers !== undefined && !importers.includes(from);
      const allowed = rule.allow === "*" || rule.allow.includes(to);
      const file = `packages/${from}/${PROBE_DIR}/edge-${to}.ts`;
      if (refusedByImporters) {
        probes.push({
          name: `${from} -> ${to} is refused (importers)`,
          file,
          content: `import "@ashara/${to}";\n`,
          violation: reportLine(file, from, to, `package "${to}" admits only importers [${importers.join(", ")}]`),
        });
      } else if (!allowed) {
        probes.push({
          name: `${from} -> ${to} is refused (allow)`,
          file,
          content: `import "@ashara/${to}";\n`,
          violation: reportLine(file, from, to, `package "${to}" not in allow list`),
        });
      } else {
        const globs = rule.restrict?.[to];
        if (globs !== undefined) {
          probes.push({
            name: `${from} -> ${to} is confined to ${globs.join(", ")}`,
            file,
            content: `import "@ashara/${to}";\n`,
            violation: reportLine(file, from, to, `only ${globs.join(", ")} may import package "${to}"`),
          });
          const inside = globs[0].includes("*")
            ? `packages/${from}/${globs[0].replace("*", `__boundary_probe_${to}`)}`
            : `packages/${from}/${globs[0]}`;
          probes.push({ name: `${from} -> ${to} is permitted in ${globs[0]}`, file: inside, content: `import "@ashara/${to}";\n`, violation: null });
        } else {
          probes.push({ name: `${from} -> ${to} is permitted`, file, content: `import "@ashara/${to}";\n`, violation: null });
        }
      }
    }
  }
  probes.push({ name: "integration simulator imports only listed names", ...NAMED_ONLY_PROBE });
  probes.push({ name: "a manifest name literal in production source is refused", ...STACK_LITERAL_PROBE });
  probes.push(...STAND_IN_PROBES);
  probes.push(...BOUNDS_TABLE_PROBES);
  return probes;
}

function copyTree(packages: readonly string[], into: string): void {
  fs.mkdirSync(path.join(into, "scripts"), { recursive: true });
  for (const file of ["boundary-rules.toml", "tsconfig.json", "scripts/check-boundaries.ts", "scripts/optional-deps.ts", "scripts/price-defaults.ts", "scripts/stack-literals.ts"]) {
    fs.copyFileSync(path.join(REPO, file), path.join(into, file));
  }
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(into, "node_modules"), "dir");
  for (const pkg of packages) {
    // The optional-deps scan resolves @ashara/* by each package's exports.
    fs.mkdirSync(path.join(into, "packages", pkg), { recursive: true });
    fs.copyFileSync(path.join(REPO, "packages", pkg, "package.json"), path.join(into, "packages", pkg, "package.json"));
    for (const dir of ["src", "test"]) {
      const from = path.join(REPO, "packages", pkg, dir);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, path.join(into, "packages", pkg, dir), {
        recursive: true,
        filter: (source) => !source.includes(`${path.sep}node_modules`) && (fs.statSync(source).isDirectory() || source.endsWith(".ts")),
      });
    }
  }
}

function plant(root: string, probe: PlannedProbe): void {
  const target = path.join(root, probe.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, probe.content);
    return;
  }
  // A restrict rule that lists files by name is probed inside one of them; the file passed the
  // clean run, so a permitted probe there must leave it reporting nothing, and a violating one
  // planted at its head is reported at :1.
  if (probe.violation !== null && probe.prepend !== true) {
    throw new ProbeTreeError("plant", `${probe.file} exists; a violating probe must be a file of its own, reported at :1`);
  }
  fs.writeFileSync(target, `${probe.content}${fs.readFileSync(target, "utf-8")}`);
}

function runChecker(root: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "scripts", "check-boundaries.ts")], {
    cwd: root,
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (result.error !== undefined) throw new ProbeTreeError("run check-boundaries", result.error.message);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const VIOLATION_LINE = /^ {2}(\S+:\d+ {2}.+)$/;

describe("boundary-rules.toml against the ADR-075 map", () => {
  const packages = fs.readdirSync(path.join(REPO, "packages"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const probes = plannedProbes(packages.filter((pkg) => pkg in MAP));
  let scratch = "";
  let clean: { status: number | null; output: string } = { status: null, output: "" };
  let probed: { status: number | null; output: string } = { status: null, output: "" };
  let reported = new Set<string>();

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ashara-boundary-probes-"));
    copyTree(packages, scratch);
    clean = runChecker(scratch);
    for (const probe of probes) plant(scratch, probe);
    probed = runChecker(scratch);
    reported = new Set(probed.output.split("\n").flatMap((line) => {
      const match = VIOLATION_LINE.exec(line);
      return match === null ? [] : [match[1]];
    }));
  }, 300_000);

  afterAll(() => {
    if (scratch !== "") fs.rmSync(scratch, { recursive: true, force: true });
  });

  test("the map names every package under packages/ and nothing else", () => {
    expect(Object.keys(MAP).sort()).toEqual(packages);
  });

  test("the unprobed tree passes", () => {
    expect(clean.output).toContain("0 violations");
    expect(clean.status).toBe(0);
  });

  test("the probed tree fails", () => {
    expect(probed.status).toBe(1);
  });

  test.each(probes)("$name", (probe) => {
    if (probe.violation === null) {
      expect([...reported].filter((line) => line.startsWith(`${probe.file}:`))).toEqual([]);
    } else {
      expect(reported).toContain(probe.violation);
    }
  });

  test("the checker reports nothing the probes did not plant", () => {
    const expected = new Set(probes.flatMap((probe) => (probe.violation === null ? [] : [probe.violation])));
    expect([...reported].filter((line) => !expected.has(line))).toEqual([]);
    expect(probed.output).toContain(`${expected.size} violations found`);
  });
});

/**
 * Negative probes for boundary-rules.toml (ADR-075 context map), run against the real checker.
 *
 * The map below is the expected side: for every package it states the packages it may import, the
 * packages that admit only some importers, and the files a restricted edge is confined to. The test
 * copies packages/, the rules and the checker into a scratch tree, plants one violating import per
 * forbidden package pair, per restrict rule and for the named-only rule, plus one permitted import
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
  return probes;
}

function copyTree(packages: readonly string[], into: string): void {
  fs.mkdirSync(path.join(into, "scripts"), { recursive: true });
  for (const file of ["boundary-rules.toml", "scripts/check-boundaries.ts", "scripts/price-defaults.ts"]) {
    fs.copyFileSync(path.join(REPO, file), path.join(into, file));
  }
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(into, "node_modules"), "dir");
  for (const pkg of packages) {
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
  // clean run, so a permitted probe there must leave it reporting nothing.
  if (probe.violation !== null) {
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

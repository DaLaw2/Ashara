import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DependencyMap = z.record(z.string(), z.string());

const Manifest = z.object({
  name: z.string().min(1),
  dependencies: DependencyMap.optional(),
  devDependencies: DependencyMap.optional(),
  optionalDependencies: DependencyMap.optional(),
  peerDependencies: DependencyMap.optional(),
});

const Lockfile = z.object({
  packages: z.record(z.string(), z.object({ version: z.string().optional() })),
});

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ALIAS = /^npm:(?:@[^/@]+\/)?[^/@]+@(.+)$/;

function readJson(relative: string): unknown {
  return z.string().transform((text): unknown => JSON.parse(text)).parse(fs.readFileSync(path.join(ROOT, relative), "utf8"));
}

function manifestPaths(): string[] {
  const workspaces = fs.readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("packages", entry.name, "package.json"))
    .filter((relative) => fs.existsSync(path.join(ROOT, relative)));
  return ["package.json", ...workspaces];
}

interface Declaration {
  readonly manifest: string;
  readonly spec: string;
}

// The workspace packages themselves are linked, not fetched, so only fetched dependencies carry a version to agree on.
function externalDeclarations(): Map<string, Declaration[]> {
  const manifests = manifestPaths().map((relative) => ({ relative, manifest: Manifest.parse(readJson(relative)) }));
  const workspaceNames = new Set(manifests.map(({ manifest }) => manifest.name));
  const declared = new Map<string, Declaration[]>();
  for (const { relative, manifest } of manifests) {
    const sections = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies];
    for (const section of sections) {
      for (const [name, spec] of Object.entries(section ?? {})) {
        if (workspaceNames.has(name)) continue;
        declared.set(name, [...(declared.get(name) ?? []), { manifest: relative, spec }]);
      }
    }
  }
  return declared;
}

function pinnedVersion(name: string, spec: string): string {
  if (EXACT.test(spec)) return spec;
  const aliased = ALIAS.exec(spec)?.[1];
  if (aliased !== undefined && EXACT.test(aliased)) return aliased;
  throw new TypeError(`${name} is declared as "${spec}", which pins no exact version`);
}

// A dependency upgraded in one workspace and not another installs two copies, and the stale one keeps its advisories.
describe("dependency versions", () => {
  const declared = externalDeclarations();

  test("the manifests declare fetched dependencies", () => {
    expect(declared.size).toBeGreaterThan(0);
  });

  test("every fetched dependency is declared at one version across every workspace manifest", () => {
    const disagreements = [...declared].flatMap(([name, declarations]) => {
      const specs = new Set(declarations.map(({ spec }) => spec));
      return specs.size > 1 ? [`${name}: ${declarations.map(({ manifest, spec }) => `${manifest} ${spec}`).join(", ")}`] : [];
    });
    expect(disagreements).toEqual([]);
  });

  test("the lockfile resolves every fetched dependency at the exact version its manifests pin", () => {
    const lock = Lockfile.parse(readJson("package-lock.json"));
    const mismatches = [...declared].flatMap(([name, declarations]) => {
      const first = declarations[0];
      if (first === undefined) throw new TypeError(`${name} has no declaration`);
      const pinned = pinnedVersion(name, first.spec);
      const resolved = lock.packages[`node_modules/${name}`]?.version;
      return resolved === pinned ? [] : [`${name}: pinned ${pinned}, locked ${String(resolved)}`];
    });
    expect(mismatches).toEqual([]);
  });
});

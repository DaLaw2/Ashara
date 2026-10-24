import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { extractCommentLines } from "./check-comments.js";

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
type Lockfile = z.output<typeof Lockfile>;

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

/** Every copy of `name` the lockfile installs: the hoisted one and each nested under another package or a workspace. */
function lockedCopies(lock: Lockfile, name: string): { key: string; version: string | undefined }[] {
  return Object.entries(lock.packages)
    .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
    .map(([key, entry]) => ({ key, version: entry.version }));
}

function lockMismatches(lock: Lockfile, declared: ReadonlyMap<string, readonly Declaration[]>): string[] {
  return [...declared].flatMap(([name, declarations]) => {
    const first = declarations[0];
    if (first === undefined) throw new TypeError(`${name} has no declaration`);
    const pinned = pinnedVersion(name, first.spec);
    const copies = lockedCopies(lock, name);
    if (copies.length === 0) return [`${name}: pinned ${pinned}, not locked`];
    return copies.filter(({ version }) => version !== pinned).map(({ key, version }) => `${name}: pinned ${pinned}, ${key} locked ${String(version)}`);
  });
}

/** Every package the lockfile installs, at any depth, by name. */
function allLockfileDependencyNames(lock: Lockfile = Lockfile.parse(readJson("package-lock.json"))): string[] {
  const names = new Set<string>();
  for (const key of Object.keys(lock.packages)) {
    const at = key.lastIndexOf("node_modules/");
    if (at !== -1) names.add(key.slice(at + "node_modules/".length));
  }
  return [...names];
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** The comment lines that name one of `tools` followed by a version number. */
function versionedToolComments(files: ReadonlyMap<string, string>, tools: readonly string[]): string[] {
  const named = new RegExp(`(?<![\\w@/.-])(?:${tools.map(escaped).join("|")})\\s+v?\\d+(?:\\.\\d+)*\\b`, "i");
  const found: string[] = [];
  for (const [file, content] of files) {
    for (const { line, text } of extractCommentLines(file, content)) if (named.test(text)) found.push(`${file}:${line}: ${text.trim()}`);
  }
  return found;
}

function trackedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0")) {
    const full = path.join(ROOT, file);
    if (file !== "" && fs.existsSync(full) && fs.statSync(full).isFile()) files.set(file, fs.readFileSync(full, "utf8"));
  }
  return files;
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

  test("the lockfile resolves every copy of every fetched dependency, nested ones included, at the exact version its manifests pin", () => {
    expect(lockMismatches(Lockfile.parse(readJson("package-lock.json")), declared)).toEqual([]);
  });

  test("a nested copy at another version is reported, under another package or under a workspace", () => {
    const zod: Declaration[] = [{ manifest: "package.json", spec: "4.6.7" }];
    const lock: Lockfile = {
      packages: {
        "": {},
        "node_modules/zod": { version: "4.6.7" },
        "node_modules/a/node_modules/zod": { version: "3.25.0" },
        "packages/x/node_modules/zod": { version: "4.0.0" },
        "node_modules/not-zod": { version: "1.0.0" },
      },
    };
    expect(lockMismatches(lock, new Map([["zod", zod]]))).toEqual([
      "zod: pinned 4.6.7, node_modules/a/node_modules/zod locked 3.25.0",
      "zod: pinned 4.6.7, packages/x/node_modules/zod locked 4.0.0",
    ]);
    expect(lockMismatches({ packages: { "": {} } }, new Map([["zod", zod]]))).toEqual(["zod: pinned 4.6.7, not locked"]);
  });
});

// A comment that pins a dependency's version goes stale on the next upgrade, which never edits it.
describe("dependency versions in comments", () => {
  test("no comment names any package the lockfile installs at a version", () => {
    expect(versionedToolComments(trackedFiles(), allLockfileDependencyNames())).toEqual([]);
  });

  test("the names come from every lockfile entry, nested and scoped ones included, and not from workspace paths", () => {
    const lock: Lockfile = {
      packages: {
        "": {},
        "node_modules/pg": { version: "8.22.0" },
        "node_modules/a/node_modules/ai": { version: "7.0.128" },
        "node_modules/@scope/x": { version: "1.0.0" },
        "packages/db": {},
      },
    };
    expect(allLockfileDependencyNames(lock).sort()).toEqual(["@scope/x", "ai", "pg"]);
  });

  test("a runtime dependency's version in a comment is found", () => {
    const files = new Map([
      ["a.ts", "// pg 8.22\nexport const a = 1;\n"],
      ["b.ts", "/* drops when it sums steps (ai 7.0.128) */\nexport const b = 2;\n"],
    ]);
    expect(versionedToolComments(files, allLockfileDependencyNames())).toEqual([
      "a.ts:1: // pg 8.22",
      "b.ts:1: /* drops when it sums steps (ai 7.0.128) */",
    ]);
  });

  test("a toolchain version in a comment is found, a version in code and another word's number are not", () => {
    const files = new Map([
      ["a.ts", "// on firing it exits (vitest 4.1.10, cli-api close())\nexport const a = 1;\n"],
      ["b.mts", '/* typescript v7 strips it */\nexport const b = "vitest 4.1.10";\n'],
      ["c.ts", "// my-vitest 4 and vitest-extra 2 are other packages; vitest runs it\nexport const c = 1;\n"],
    ]);
    expect(versionedToolComments(files, ["vitest", "typescript"])).toEqual([
      "a.ts:1: // on firing it exits (vitest 4.1.10, cli-api close())",
      "b.mts:1: /* typescript v7 strips it */",
    ]);
  });
});

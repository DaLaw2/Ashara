import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PackageJson = z.object({
  devDependencies: z.object({ "@types/node": z.string() }),
});

const PackageLock = z.object({
  packages: z.record(z.string(), z.object({ version: z.string().optional() })),
});
type PackageLock = z.output<typeof PackageLock>;

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function readJson(relative: string): unknown {
  return z.string().transform((text): unknown => JSON.parse(text)).parse(read(relative));
}

function major(version: string, source: string): number {
  const match = /^[\^~=v]?(\d+)(?:\.|$)/.exec(version.trim());
  if (match?.[1] === undefined) {
    throw new TypeError(`${source}: no major version in "${version}"`);
  }
  return Number(match[1]);
}

/** Every locked copy of @types/node whose major is not `runtimeMajor`, nested copies included; a lockfile with none fails. */
function offMajorCopies(lock: PackageLock, runtimeMajor: number): string[] {
  const copies = Object.entries(lock.packages).filter(([key]) => key === "node_modules/@types/node" || key.endsWith("/node_modules/@types/node"));
  if (copies.length === 0) return ["package-lock.json locks no @types/node"];
  return copies.flatMap(([key, entry]) => {
    if (entry.version === undefined) return [`${key}: no version`];
    return major(entry.version, `package-lock.json ${key}`) === runtimeMajor ? [] : [`${key}: ${entry.version}`];
  });
}

// Type definitions of a later Node major than the runtime let typecheck accept APIs the runtime lacks.
describe("Node toolchain", () => {
  const runtimeMajor = major(read(".nvmrc"), ".nvmrc");

  test("package.json pins @types/node to the .nvmrc major", () => {
    const declared = PackageJson.parse(readJson("package.json")).devDependencies["@types/node"];
    expect(major(declared, "package.json devDependencies[@types/node]")).toBe(runtimeMajor);
  });

  test("package-lock.json resolves every copy of @types/node, nested ones included, to the .nvmrc major", () => {
    expect(offMajorCopies(PackageLock.parse(readJson("package-lock.json")), runtimeMajor)).toEqual([]);
  });

  test("a nested copy of @types/node at another major is reported, and a lockfile with none fails", () => {
    const lock: PackageLock = {
      packages: {
        "node_modules/@types/node": { version: "24.19.2" },
        "node_modules/a/node_modules/@types/node": { version: "25.0.1" },
        "node_modules/@types/node-fetch": { version: "2.6.0" },
      },
    };
    expect(offMajorCopies(lock, 24)).toEqual(["node_modules/a/node_modules/@types/node: 25.0.1"]);
    expect(offMajorCopies({ packages: {} }, 24)).toEqual(["package-lock.json locks no @types/node"]);
  });

  test(".npmrc makes the engines range binding on install", () => {
    const settings = read(".npmrc")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith(";"));
    expect(settings).toContain("engine-strict=true");
  });
});

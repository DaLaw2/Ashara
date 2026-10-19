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
  packages: z.object({
    "node_modules/@types/node": z.object({ version: z.string() }),
  }),
});

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

// Type definitions of a later Node major than the runtime let typecheck accept APIs the runtime lacks.
describe("Node toolchain", () => {
  const runtimeMajor = major(read(".nvmrc"), ".nvmrc");

  test("package.json pins @types/node to the .nvmrc major", () => {
    const declared = PackageJson.parse(readJson("package.json")).devDependencies["@types/node"];
    expect(major(declared, "package.json devDependencies[@types/node]")).toBe(runtimeMajor);
  });

  test("package-lock.json resolves @types/node to the .nvmrc major", () => {
    const locked = PackageLock.parse(readJson("package-lock.json")).packages["node_modules/@types/node"].version;
    expect(major(locked, "package-lock.json node_modules/@types/node")).toBe(runtimeMajor);
  });

  test(".npmrc makes the engines range binding on install", () => {
    const settings = read(".npmrc")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith(";"));
    expect(settings).toContain("engine-strict=true");
  });
});

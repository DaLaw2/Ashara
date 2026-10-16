import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { findUnsuppliedOptionalMembers } from "./optional-deps.js";

const DEPS_MODULE = [
  "export interface ServiceDeps {",
  "  readonly required: number;",
  "  readonly viaConstructor?: number;",
  "  readonly viaSpread?: number;",
  "  readonly viaAssignment?: number;",
  "  readonly viaOmit?: number;",
  "  readonly planted?: number;",
  "}",
  "export type AliasConfig = { readonly onlyInUnreachable?: string };",
  "export class Service {",
  "  constructor(readonly deps: ServiceDeps) {}",
  "}",
].join("\n");

const ENTRY_MODULE = [
  'import { Service } from "@ashara/a";',
  'import type { ServiceDeps } from "@ashara/a";',
  "const flag = Math.random() > 0.5;",
  "const partial: Omit<ServiceDeps, \"required\"> = { viaOmit: 4 };",
  "const deps: { -readonly [K in keyof ServiceDeps]: ServiceDeps[K] } = { required: 1, viaConstructor: 2, ...(flag ? {} : { viaSpread: 3 }) };",
  "deps.viaAssignment = 5;",
  "export const service = new Service({ ...partial, ...deps });",
].join("\n");

let root = "";

function write(relative: string, content: string): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "optional-deps-"));
  write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler", types: [] } }));
  write("packages/a/package.json", JSON.stringify({ name: "@ashara/a", exports: { ".": "./src/index.ts" } }));
  write("packages/a/src/index.ts", 'export * from "./deps.js";');
  write("packages/a/src/deps.ts", DEPS_MODULE);
  // Not reached from the entry, and a test module: neither supplies anything.
  write("packages/a/src/unused.ts", 'import type { ServiceDeps, AliasConfig } from "./deps.js";\nexport const d: Partial<ServiceDeps> = { planted: 1 };\nexport const c: AliasConfig = { onlyInUnreachable: "x" };');
  write("packages/a/src/deps.test.ts", 'import type { ServiceDeps } from "./deps.js";\nexport const t: ServiceDeps = { required: 1, planted: 2 };');
  write("packages/server/package.json", JSON.stringify({ name: "@ashara/server", exports: { ".": "./src/index.ts" } }));
  write("packages/server/src/index.ts", ENTRY_MODULE);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const scan = (allowlist: Parameters<typeof findUnsuppliedOptionalMembers>[0]["allowlist"]) =>
  findUnsuppliedOptionalMembers({ root, entry: "packages/server/src/index.ts", allowlist }).map((f) => [f.declaration, f.member, f.line]);

describe("findUnsuppliedOptionalMembers", () => {
  test("a planted optional member no reached module supplies fails; every supply shape the entry uses counts", () => {
    expect(scan([])).toEqual([
      ["ServiceDeps", "planted", 7],
      ["AliasConfig", "onlyInUnreachable", 9],
    ]);
  });

  test("an allowlisted policy default passes, and a stale allowlist entry fails", () => {
    expect(
      scan([
        { file: "packages/a/src/deps.ts", declaration: "ServiceDeps", member: "planted", reason: "omitting it is consent" },
        { file: "packages/a/src/deps.ts", declaration: "ServiceDeps", member: "viaConstructor", reason: "stale: it is supplied" },
      ]),
    ).toEqual([
      ["AliasConfig", "onlyInUnreachable", 9],
      ["ServiceDeps", "viaConstructor", 0],
    ]);
  });
});

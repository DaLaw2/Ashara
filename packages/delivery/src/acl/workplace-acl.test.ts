import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { WORK_KINDS } from "@ashara/organization";
import { attemptGrantOf } from "./organization-acl.js";
import { PUBLIC_INTERFACE_FILE, SCAFFOLD_PLACEHOLDER_MARKER } from "./quality-acl.js";
import { attemptProfileOf } from "./workplace-acl.js";

// Which tools an attempt at a kind of work is given is Organization's grant: Delivery forwards it to
// Workplace and decides none of it, so no Delivery source names a tool profile.

const SRC = join(import.meta.dirname, "..");
const PROFILE_LITERAL = /["'`](build-environment|define-checks|run-and-dispute-checks|run-checks)["'`]/;
const PROFILE_TABLE = /Record<\s*WorkKind\s*,\s*ToolProfile\s*>/;

function productionSources(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("attemptProfileOf", () => {
  it("forwards Organization's grant for every kind of work and for unkinded work", () => {
    for (const kind of [...WORK_KINDS, null]) {
      expect(attemptProfileOf(kind), String(kind)).toEqual(attemptGrantOf(kind, { publicInterfaceFile: PUBLIC_INTERFACE_FILE, placeholderMarker: SCAFFOLD_PLACEHOLDER_MARKER }));
    }
  });

  it("no production source of Delivery decides a tool profile", () => {
    const deciding = productionSources(SRC).filter((file) => {
      const text = readFileSync(file, "utf8");
      return PROFILE_LITERAL.test(text) || PROFILE_TABLE.test(text);
    });
    expect(deciding.map((file) => relative(SRC, file))).toEqual([]);
  });
});

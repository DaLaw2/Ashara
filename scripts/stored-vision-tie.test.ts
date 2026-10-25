import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { checkoutProgram } from "./module-program.js";

const FILE = path.join(import.meta.dirname, "..", "packages", "engagement", "src", "vision-language", "stored-vision.ts");
const TEXT = fs.readFileSync(FILE, "utf-8");

/** The type errors the checker finds in stored-vision.ts written as `text`. */
function typeErrors(text: string): string[] {
  const built = checkoutProgram(new Map([[FILE, text]]));
  const source = built.sourceFile(FILE);
  if (source === undefined) throw new Error("stored-vision.ts is not in its own program");
  return built.program.getSemanticDiagnostics(source).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

/** `TEXT` with `from` replaced by `to`, where `from` occurs exactly once. */
function drifted(from: string, to: string): string {
  expect(TEXT.split(from)).toHaveLength(2);
  return TEXT.replace(from, to);
}

describe("StoredVision and StoredVisionSchema are tied: drift in either direction fails typecheck", () => {
  test("as written, the module typechecks", () => {
    expect(typeErrors(TEXT)).toEqual([]);
  });

  test.each([
    ["the schema reads a field StoredVision does not declare", "  exclusions: z.unknown(),\n});", "  exclusions: z.unknown(),\n  extra: z.string(),\n});"],
    ["StoredVision drops a field the schema reads", "  readonly exclusions: unknown;\n}", "}"],
    ["StoredVision declares a field the schema does not read", "  readonly exclusions: unknown;\n}", "  readonly exclusions: unknown;\n  readonly extra: string;\n}"],
    ["the schema drops a field StoredVision declares", "  exclusions: z.unknown(),\n});", "});"],
    ["the schema reads an optional field StoredVision does not declare", "  exclusions: z.unknown(),\n});", "  exclusions: z.unknown(),\n  extra: z.string().optional(),\n});"],
    ["StoredVision declares an optional field the schema does not read", "  readonly exclusions: unknown;\n}", "  readonly exclusions: unknown;\n  readonly extra?: string;\n}"],
    ["StoredVision makes a field optional the schema requires", "  readonly summary: string;", "  readonly summary?: string;"],
  ])("%s", (_name, from, to) => {
    expect(typeErrors(drifted(from, to))).not.toEqual([]);
  });
});

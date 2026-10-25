import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findStackLiterals, parseStackLiteralRules } from "./stack-literals.js";

const REPO = join(import.meta.dirname, "..");
const rules = parseStackLiteralRules(readFileSync(join(REPO, "boundary-rules.toml"), "utf-8"), "boundary-rules.toml");
const tokens = [...rules.tokens.values()].flat();

describe("findStackLiterals", () => {
  test("reports a manifest name, a language, an extension regex and a toolchain in literals", () => {
    const source = [
      'import { x } from "./manifest.js";',
      'export const MANIFEST = "Cargo.toml";',
      "const language = `Python`;",
      "const SOURCE_RE = /\\.py$/;",
      "const run = `npm ${x} install`;",
      "// package.json in a comment is prose, not a decision",
      "const neighbours = [\"x.pyc\", \".npmrc\", \"composeAshara\", \"makes\"];",
    ].join("\n");
    expect(findStackLiterals(source, "probe.ts", tokens).map((hit) => [hit.line, hit.token])).toEqual([
      [2, "Cargo.toml"],
      [3, "python"],
      [4, ".py"],
      [5, "npm"],
    ]);
  });
});

describe("parseStackLiteralRules", () => {
  test("refuses a missing section, an exemption of an unlisted token and an unknown key", () => {
    expect(() => parseStackLiteralRules("[shared]\nallow = []\n", "r.toml")).toThrow(/section is missing/);
    expect(() =>
      parseStackLiteralRules('[stack-literals]\ntokens.manifest = ["Cargo.toml"]\nexempt.a = { file = "f.ts", tokens = ["npm"], reason = "r" }\n', "r.toml"),
    ).toThrow(/no token group lists/);
    expect(() => parseStackLiteralRules('[stack-literals]\ntokens.manifest = ["Cargo.toml"]\nallow = []\n', "r.toml")).toThrow(/unrecognised key/);
  });
});

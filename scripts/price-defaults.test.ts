import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findPriceColumnDefaults } from "./price-defaults.js";

describe("findPriceColumnDefaults", () => {
  test("the schema has no default on a price or cost column", () => {
    const schema = readFileSync(join(import.meta.dirname, "..", "packages", "db", "src", "schema.ts"), "utf-8");
    expect(findPriceColumnDefaults(schema)).toEqual([]);
  });

  test("reports a default on a price column, also across continuation lines, and ignores other columns", () => {
    const probe = [
      "export const t = pgTable(\"t\", {",
      "  inputCostPer1m: doublePrecision(\"input_cost_per_1m\").notNull().default(0),",
      "  rate: doublePrecision(\"price_usd\")",
      "    .notNull()",
      "    .default(1.5),",
      "  maxContextTokens: integer(\"max_context_tokens\").notNull().default(128000),",
      "  costUsd: numeric(\"cost_usd\", { precision: 20 }),",
      "});",
    ].join("\n");
    expect(findPriceColumnDefaults(probe).map((d) => [d.line, d.column])).toEqual([
      [2, "input_cost_per_1m"],
      [3, "price_usd"],
    ]);
  });
});

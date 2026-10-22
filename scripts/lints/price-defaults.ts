/**
 * A default on a price or cost column of a packages/db/src/schema/ module: it reads an insert that
 * forgot the rate as a free model (scripts/price-defaults.ts).
 */

import fs from "node:fs";
import path from "node:path";
import { findPriceColumnDefaults } from "../price-defaults.js";
import type { LintContext, Violation } from "./lint.js";

export function run(context: LintContext): Violation[] {
  const { root, packagesDir } = context;
  const violations: Violation[] = [];
  const schemaDir = path.join(packagesDir, "db", "src", "schema");
  const schemaModules = fs.readdirSync(schemaDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  if (schemaModules.length === 0) {
    violations.push({
      file: path.relative(root, schemaDir),
      line: 0,
      fromPkg: "db",
      specifier: "schema",
      reason: "no schema module to scan for price defaults; a scan of nothing would pass",
    });
  }
  for (const name of schemaModules) {
    const schemaPath = path.join(schemaDir, name);
    for (const found of findPriceColumnDefaults(fs.readFileSync(schemaPath, "utf-8"))) {
      violations.push({
        file: path.relative(root, schemaPath),
        line: found.line,
        fromPkg: "db",
        specifier: found.column,
        reason: `a price or cost column has a default; every writer must supply the rate (${found.text})`,
      });
    }
  }
  return violations;
}

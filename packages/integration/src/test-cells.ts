import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import { testInstancePrefix } from "./cell-leak-guard.js";

class TestCellRunMissing extends Error {
  constructor(readonly provided: unknown) {
    super(
      `testCellInstance: the vitest run provides no cellRun (got ${JSON.stringify(provided) ?? "undefined"}); ` +
        "vitest.config.mts must name packages/integration/src/cell-leak-guard.ts as globalSetup",
    );
    this.name = "TestCellRunMissing";
  }
}

/**
 * A fresh ashara.instance for a test's cells, owned by this vitest run, so the run's end finds any
 * cell no path of the test removed (cell-leak-guard.ts). Outside a run that provides one, it throws:
 * a cell with an instance nothing reaps is never started.
 * @testseam only test files start real cells; a production instance is cellInstanceFor
 */
export function testCellInstance(): string {
  const cellRun = inject("cellRun");
  if (typeof cellRun !== "string" || cellRun === "") {
    throw new TestCellRunMissing(cellRun);
  }
  return `${testInstancePrefix(cellRun)}${randomUUID()}`;
}

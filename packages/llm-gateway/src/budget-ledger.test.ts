import { describe, expect, test } from "vitest";
import { BudgetLedger } from "./budget-ledger.js";

describe("BudgetLedger", () => {
  test("isOverBudget trips once spend reaches the limit", () => {
    const ledger = new BudgetLedger();
    expect(ledger.isOverBudget(1.0)).toBe(false);

    ledger.record(1.0, "anthropic");
    expect(ledger.isOverBudget(1.0)).toBe(true);
  });
});

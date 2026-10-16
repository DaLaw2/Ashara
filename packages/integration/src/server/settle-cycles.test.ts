import { expect, test } from "vitest";
import { FIRST_FAULT_BACKOFF_SECONDS } from "@ashara/shared";
import { REPORT_RETRY_MS } from "../simulator/run.js";

// The simulator's settle cycles are counted from the wait before a faulted report is retried. It
// may not import the product's backoff (ADR-081), so this test holds its copy to the product's: with
// a longer backoff a run would end before the retry that sends the report, and its report clause
// would judge lost a report the product still sends.
test("the simulator's report retry wait is the product's first fault backoff", () => {
  expect(REPORT_RETRY_MS).toBe(FIRST_FAULT_BACKOFF_SECONDS * 1000);
});

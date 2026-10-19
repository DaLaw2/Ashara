import { describe, expect, it } from "vitest";
import { soak } from "./simulator-harness.js";

/* simulate.ts --jobs under the adversarial profile, beside soak.test.ts's own-profile seeds so vitest runs the two on separate workers. */
describe("simulate.ts --jobs", () => {
  // The adversarial profile's misbehaviour is drawn from the tape like every other choice, so its
  // seeds too are a function of the seed alone; the coverage lines (MODEL_PATHS met) are compared too.
  it("reports every adversarial seed as the serial run does", async () => {
    const args = ["--seeds", "3", "--start", "11", "--profile", "adversarial"];
    const serial = await soak(1, args);
    const parallel = await soak(3, args);
    expect(serial.lines.some((line) => line.startsWith("model misbehaviour met (MODEL_PATHS)"))).toBe(true);
    expect(parallel).toEqual(serial);
    expect(serial.exitCode).toBe(0);
  }, 300_000);
});

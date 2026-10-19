import { describe, expect, it } from "vitest";
import { soak } from "./simulator-harness.js";

/*
 * simulate.ts --jobs at one project under the seeds' own profiles; the adversarial profile is
 * soak-adversarial.test.ts, so vitest runs the two on separate workers.
 */
describe("simulate.ts --jobs", () => {
  // Seeds 85-86 at one project. A worker's seed is a function of the seed and the mode alone:
  // in two processes at once, every line but the time is the serial run's.
  it("reports every seed as the serial run does, in seed order", async () => {
    const args = ["--seeds", "2", "--start", "85"];
    const serial = await soak(1, args);
    const parallel = await soak(2, args);
    expect(serial.lines.filter((line) => line.startsWith("seed ")).map((line) => line.split(" (")[0])).toEqual(["seed 85", "seed 86"]);
    expect(parallel).toEqual(serial);
    expect(serial.exitCode).toBe(0);
  }, 300_000);
});

import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { capturingConsole } from "./console-capture.js";
import type { ConsoleSink } from "./console-capture.js";

function into(lines: string[]): ConsoleSink {
  return (level, args) => lines.push(`${level} ${args.map(String).join(" ")}`);
}

describe("capturingConsole", () => {
  // A run's work that outlives it (a fire-and-forget promise, a timer) logs after the run ended and
  // the next one began: it reaches its own run's sink, never the next run's, and the console's own
  // functions are back once every capture has ended.
  it("keeps output a capture's work writes after it ended out of the next capture", async () => {
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const first: string[] = [];
    const second: string[] = [];
    let late: Promise<void> = Promise.resolve();
    await capturingConsole(into(first), async () => {
      console.log("first, while it runs");
      late = sleep(50).then(() => console.warn("first, after it ended"));
    });
    await capturingConsole(into(second), async () => {
      console.info("second, while it runs");
      await late;
      console.error("second, after the first's late line");
    });
    expect(first).toEqual(["log first, while it runs", "warn first, after it ended"]);
    expect(second).toEqual(["info second, while it runs", "error second, after the first's late line"]);
    expect({ log: console.log, info: console.info, warn: console.warn, error: console.error }).toEqual(original);
  });

  it("keeps two overlapping captures' output apart and restores the console after the last", async () => {
    const original = console.log;
    const first: string[] = [];
    const second: string[] = [];
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outer = capturingConsole(into(first), async () => {
      console.log("a1");
      await held;
      console.log("a2");
    });
    await capturingConsole(into(second), async () => {
      console.log("b1");
      await sleep(10);
      console.log("b2");
    });
    expect(console.log).not.toBe(original);
    release();
    await outer;
    expect(first).toEqual(["log a1", "log a2"]);
    expect(second).toEqual(["log b1", "log b2"]);
    expect(console.log).toBe(original);
  });

  it("restores the console when the captured work throws", async () => {
    const original = console.log;
    class Planted extends Error {}
    await expect(capturingConsole(into([]), () => Promise.reject(new Planted("planted")))).rejects.toBeInstanceOf(Planted);
    expect(console.log).toBe(original);
  });
});

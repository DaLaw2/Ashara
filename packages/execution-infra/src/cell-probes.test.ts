import { describe, expect, it } from "vitest";
import { probeOutboundHost } from "./cell-probes.js";
import type { Cell, ExecResult } from "./podman.js";

function cellPrinting(stdout: string): Cell {
  const result: ExecResult = { exitCode: 0, stdout, stderr: "", timedOut: false, statusLost: false, stdoutTruncated: false, stderrTruncated: false };
  return {
    id: "c".repeat(64),
    spec: { image: "img", project: "p", task: "t", role: "verifier", instance: "i", mount: { hostPath: "/nowhere" } },
    exec: () => Promise.resolve(result),
    teardown: () => Promise.resolve(),
  };
}

describe("probeOutboundHost", () => {
  const isolated = "routes: 0\nconnect: wget exit 1\n";

  it("holds with loopback only, no route and a refused connect", async () => {
    expect((await probeOutboundHost(cellPrinting(`interfaces: lo\n${isolated}`), "1.1.1.1")).held).toBe(true);
  });

  it("does not hold on an empty or missing interface list: nothing was observed", async () => {
    expect((await probeOutboundHost(cellPrinting(`interfaces:\n${isolated}`), "1.1.1.1")).held).toBe(false);
    expect((await probeOutboundHost(cellPrinting(isolated), "1.1.1.1")).held).toBe(false);
  });
});

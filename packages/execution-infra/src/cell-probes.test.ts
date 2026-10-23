import { describe, expect, it } from "vitest";
import { expectedCpuMax } from "./cell-limits.js";
import { probeCredentialRead, probeOutboundHost, probeResourceCaps, summarizeProbes } from "./cell-probes.js";
import { InvalidCellRequest } from "./errors.js";
import type { Cell, ExecResult } from "./podman.js";

/** A signal that never aborts: these probes run to their end. */
const LIVE = new AbortController().signal;

function cellPrinting(stdout: string): Cell {
  const result: ExecResult = { exitCode: 0, stdout, stderr: "", timedOut: false, statusLost: false, stdoutCut: null, stderrCut: null };
  return {
    id: "c".repeat(64),
    spec: { image: "img", project: "p", task: "t", role: "verifier", instance: "i", mount: { hostPath: "/nowhere" } },
    exec: () => Promise.resolve(result),
    teardown: () => Promise.resolve(),
  };
}

describe("probeCredentialRead", () => {
  it("sends the probed paths on stdin, never in argv, which reaches the cell's environment", async () => {
    const calls: Array<{ argv: readonly string[]; stdin: unknown }> = [];
    const path = "/home/someone/project/.env";
    const cell: Cell = {
      ...cellPrinting(""),
      exec: (argv, options) => {
        calls.push({ argv, stdin: options.stdin });
        const result: ExecResult = {
          exitCode: 0, stdout: `path ${path} absent\n`, stderr: "", timedOut: false, statusLost: false, stdoutCut: null, stderrCut: null,
        };
        return Promise.resolve(result);
      },
    };
    const verdict = await probeCredentialRead(cell, { paths: [path], values: [{ name: "INIT_CWD", value: "/home/someone/project" }] }, LIVE);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv.some((arg) => arg.includes(path))).toBe(false);
    expect(calls[0]?.stdin).toBe(`${path}\n`);
    expect(verdict).toMatchObject({ outcome: "held" });
  });

  it("refuses a path that cannot be sent as one line rather than probe something else", async () => {
    await expect(probeCredentialRead(cellPrinting(""), { paths: ["/a\n/b"], values: [] }, LIVE)).rejects.toThrow(InvalidCellRequest);
  });

  it("refuses an empty canary set and an empty value: nothing probed must never read as held", async () => {
    await expect(probeCredentialRead(cellPrinting(""), { paths: [], values: [] }, LIVE)).rejects.toThrow(InvalidCellRequest);
    await expect(probeCredentialRead(cellPrinting(""), { paths: ["/a"], values: [{ name: "EMPTY", value: "" }] }, LIVE)).rejects.toThrow(InvalidCellRequest);
  });
});

describe("probeResourceCaps", () => {
  const limits = { memoryBytes: 1024, cpus: 1, pids: 64 };
  const printed = (memory: string, controllers = "cpuset cpu io memory pids"): string =>
    `cgroup.controllers=${controllers}\nmemory.max=${memory}\nmemory.swap.max=0\ncpu.max=${expectedCpuMax(limits)}\npids.max=64\n`;

  it("holds when every cap reads as configured", async () => {
    expect((await probeResourceCaps(cellPrinting(printed("1024")), limits, LIVE)).outcome).toBe("held");
  });

  it("is unverifiable, not breached, when a cap file could not be read and no read cap differs", async () => {
    const verdict = await probeResourceCaps(cellPrinting(printed("unreadable")), limits, LIVE);
    expect(verdict.outcome).toBe("unverifiable");
    expect(verdict.evidence).toContain("not observed: memory.max");
  });

  it("is breached when a cap reads with another value", async () => {
    expect((await probeResourceCaps(cellPrinting(printed("max")), limits, LIVE)).outcome).toBe("breached");
  });

  it("is unverifiable, naming the controller, when the host did not delegate one to the cell, whatever its file reads", async () => {
    const verdict = await probeResourceCaps(cellPrinting(printed("1024", "cpu memory")), limits, LIVE);
    expect(verdict.outcome).toBe("unverifiable");
    expect(verdict.evidence).toContain("controllers not delegated to the cell: pids (cgroup.controllers=cpu memory)");
    expect(verdict.evidence).toContain("not observed: pids.max");
  });

  it("is unverifiable when the cell's cgroup.controllers could not be read", async () => {
    const verdict = await probeResourceCaps(cellPrinting(printed("1024", "unreadable")), limits, LIVE);
    expect(verdict.outcome).toBe("unverifiable");
    expect(verdict.evidence).toContain("; cgroup.controllers=unreadable");
  });
});

describe("probeOutboundHost", () => {
  const refused = "connect: bash-dev-tcp exit 1\n  bash: connect: Network is unreachable\n";

  it("holds when a mechanism tried and failed to connect, with loopback only and no route", async () => {
    const verdict = await probeOutboundHost(cellPrinting(`interfaces: lo\nroutes: 0\n${refused}`), "1.1.1.1", LIVE);
    expect(verdict.outcome).toBe("held");
    expect(verdict.evidence).toContain("connect: bash-dev-tcp exit 1 (bash: connect: Network is unreachable)");
  });

  it("is breached when any mechanism connected, whatever the others did", async () => {
    const stdout = `interfaces: lo\nroutes: 0\n${refused}connect: wget exit 0\n`;
    expect((await probeOutboundHost(cellPrinting(stdout), "1.1.1.1", LIVE)).outcome).toBe("breached");
  });

  it("is unverifiable, never held, when the image has no mechanism to attempt a connection", async () => {
    const verdict = await probeOutboundHost(cellPrinting("interfaces: lo\nroutes: 0\nconnect: none\n"), "1.1.1.1", LIVE);
    expect(verdict.outcome).toBe("unverifiable");
    expect(verdict.evidence).toContain("no connection mechanism in the image");
    expect(summarizeProbes([verdict]).exitCode).toBe(1);
  });

  it("is unverifiable on an empty or missing interface list: nothing was observed", async () => {
    expect((await probeOutboundHost(cellPrinting(`interfaces:\nroutes: 0\n${refused}`), "1.1.1.1", LIVE)).outcome).toBe("unverifiable");
    expect((await probeOutboundHost(cellPrinting(`routes: 0\n${refused}`), "1.1.1.1", LIVE)).outcome).toBe("unverifiable");
  });

  it("is breached when a refused connect sits beside a non-loopback interface", async () => {
    expect((await probeOutboundHost(cellPrinting(`interfaces: eth0 lo\nroutes: 1\n${refused}`), "1.1.1.1", LIVE)).outcome).toBe("breached");
  });
});

describe("summarizeProbes", () => {
  it("passes only when every verdict held, and never on none", () => {
    const held = { probe: "a", outcome: "held", evidence: "" } as const;
    expect(summarizeProbes([held]).exitCode).toBe(0);
    expect(summarizeProbes([held, { ...held, outcome: "unverifiable" }])).toEqual({
      exitCode: 1,
      summary: "1 of 2 probe(s) did not hold: 0 breached, 1 unverifiable.",
    });
    expect(summarizeProbes([]).exitCode).toBe(1);
  });
});

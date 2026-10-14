import { describe, expect, it } from "vitest";
import { probeCredentialRead, probeOutboundHost } from "./cell-probes.js";
import { InvalidCellRequest } from "./errors.js";
import type { Cell, ExecResult } from "./podman.js";

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
  it("sends the probed paths on stdin, never in argv, which reaches the cell's environment (W5 D4)", async () => {
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
    const verdict = await probeCredentialRead(cell, { paths: [path], values: [{ name: "INIT_CWD", value: "/home/someone/project" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv.some((arg) => arg.includes(path))).toBe(false);
    expect(calls[0]?.stdin).toBe(`${path}\n`);
    expect(verdict).toMatchObject({ held: true });
  });

  it("refuses a path that cannot be sent as one line rather than probe something else", async () => {
    await expect(probeCredentialRead(cellPrinting(""), { paths: ["/a\n/b"], values: [] })).rejects.toThrow(InvalidCellRequest);
  });
});

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

import { afterEach, describe, expect, test } from "vitest";
import { SubstrateUnavailable } from "@ashara/execution-infra";
import { parseProjectId } from "@ashara/shared";
import { AcceptanceSweeper, observeAcceptanceSweeps } from "./acceptance-sweep.js";
import type { AcceptanceSweep, MainSweepDeps } from "./acceptance-sweep.js";
import { TerminalSweeper } from "./terminal-sweep.js";

const projectId = parseProjectId("22222222-2222-4222-8222-222222222222", "test");

function unreachable(what: string): () => never {
  return () => {
    throw new Error(`${what} must not be reached`);
  };
}

/** Deps whose substrate probe throws `probeError`, and nothing past the probe may be reached. */
function probeFailing(probeError: Error): MainSweepDeps {
  return {
    config: { workdirBase: "/srv/base" },
    cells: {
      substrate: {
        probeSubstrate: async () => {
          throw probeError;
        },
        createCell: unreachable("a cell"),
      },
      instance: "instance-1",
    },
    attemptPolicy: { perCommandTimeoutSeconds: 30 },
    environment: { images: { build: unreachable("an image build"), prune: unreachable("an image prune") }, statements: { record: unreachable("a statement"), forVersion: unreachable("a statement") } },
    checks: { completedOf: unreachable("the stored checks") },
    teardown: { teardownCell: unreachable("a teardown") },
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function observing(): AcceptanceSweep[] {
  const seen: AcceptanceSweep[] = [];
  restore = observeAcceptanceSweeps((sweep) => void seen.push(sweep));
  return seen;
}

describe("AcceptanceSweeper", () => {
  test("a substrate that does not answer leaves the sweep unrunnable, nothing decided, and the observer sees it", async () => {
    const seen = observing();
    const sweep = await new AcceptanceSweeper(probeFailing(new SubstrateUnavailable("podman", "socket gone"))).sweepForAcceptance(projectId, "/srv/target", ["g1"], []);
    expect(sweep.kind).toBe("unrunnable");
    expect(seen).toEqual([sweep]);
  });

  test("any other failure is a fault at the step it stopped at, never the machines' and never a verdict", async () => {
    observing();
    const sweep = await new AcceptanceSweeper(probeFailing(new TypeError("bug"))).sweepForAcceptance(projectId, "/srv/target", ["g1"], []);
    expect(sweep.kind).toBe("faulted");
    if (sweep.kind !== "faulted") return;
    expect(sweep.mainCommit).toBeNull();
    expect(sweep.error.message).toContain("probe the substrate failed: TypeError: bug");
  });
});

describe("TerminalSweeper", () => {
  test("runs the same sweep of main, but the acceptance observer never sees it", async () => {
    const seen = observing();
    const sweep = await new TerminalSweeper(probeFailing(new SubstrateUnavailable("podman", "socket gone"))).sweepForTerminal(projectId, "/srv/target");
    expect(sweep.kind).toBe("unrunnable");
    expect(seen).toEqual([]);
  });
});

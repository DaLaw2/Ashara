import { describe, expect, test } from "vitest";
import { parseProjectId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import type { ProjectId } from "@ashara/shared";
import { resumeInfrastructureHalts } from "./infrastructure-halts.js";
import type { InfrastructureHalts, InfrastructureProbe } from "./infrastructure-halts.js";

const A = parseProjectId("00000000-0000-4000-8000-0000000000a1", "test");
const B = parseProjectId("00000000-0000-4000-8000-0000000000a2", "test");

function haltsOf(halted: ProjectId[]) {
  const resumed: Array<{ projectId: ProjectId; evidence: string }> = [];
  const halts: InfrastructureHalts = {
    listInfrastructureHalted: async () => halted.filter((id) => !resumed.some((r) => r.projectId === id)),
    resumeFromInfrastructureHalt: async (projectId, evidence) => {
      resumed.push({ projectId, evidence });
      return "resumed";
    },
  };
  return { halts, resumed };
}

type Scripted = { readonly passed: boolean; readonly evidence: string } | Error;

function probeOf(...results: Scripted[]): InfrastructureProbe & { readonly calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async probe() {
      const result = results[Math.min(calls, results.length - 1)];
      calls++;
      if (result instanceof Error) throw result;
      return result.passed ? { passed: true, evidence: result.evidence } : { passed: false, evidence: result.evidence };
    },
  };
}

// An infrastructure halt resumes by itself.
describe("resumeInfrastructureHalts", () => {
  test("no project halted: the substrate is not probed", async () => {
    const probe = probeOf({ passed: true, evidence: "ok" });
    expect(await resumeInfrastructureHalts(haltsOf([]).halts, probe, memoryStepContainment(() => true), recordingLogger())).toBe(0);
    expect(probe.calls()).toBe(0);
  });

  test("a halt stays while the probe fails or throws, and resumes by itself on the first cycle the probe passes", async () => {
    const { halts, resumed } = haltsOf([A, B]);
    const probe = probeOf({ passed: false, evidence: "podman info exited 125" }, new Error("spawn ENOENT"), { passed: true, evidence: "version 5.4" });

    expect(await resumeInfrastructureHalts(halts, probe, memoryStepContainment(() => true), recordingLogger())).toBe(0);
    expect(await resumeInfrastructureHalts(halts, probe, memoryStepContainment(() => true), recordingLogger())).toBe(0);
    expect(resumed).toEqual([]);

    expect(await resumeInfrastructureHalts(halts, probe, memoryStepContainment(() => true), recordingLogger())).toBe(2);
    expect(resumed).toEqual([
      { projectId: A, evidence: "version 5.4" },
      { projectId: B, evidence: "version 5.4" },
    ]);

    // Nothing halted any more: no further probe.
    expect(await resumeInfrastructureHalts(halts, probe, memoryStepContainment(() => true), recordingLogger())).toBe(0);
    expect(probe.calls()).toBe(3);
  });

  test("one probe per cycle, however many projects are halted", async () => {
    const probe = probeOf({ passed: false, evidence: "down" });
    await resumeInfrastructureHalts(haltsOf([A, B]).halts, probe, memoryStepContainment(() => true), recordingLogger());
    expect(probe.calls()).toBe(1);
  });
});

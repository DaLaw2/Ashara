import type { ProjectId } from "@ashara/shared";
import { describeErrorChain } from "@ashara/shared";

// The automatic exit of a project halted on infrastructure (story s-loop-never-stop-m1 W6; design
// P17, exit X2): the owner fixes the host, and the loop resumes the project by itself. Each cycle,
// while any project is halted so, the substrate is probed once (no LLM call); a probe that passes
// ends each such halt with what it observed, the project returns to work, and the Liaison tells the
// client once. A probe that fails, or throws, leaves every halt as it is (fail-closed).

/** What the substrate probe observed: passed with its evidence, or failed with why. */
type InfrastructureProbeResult = { readonly passed: true; readonly evidence: string } | { readonly passed: false; readonly evidence: string };

/** The probe of the machines work runs on; the composition root supplies the substrate's own. */
export interface InfrastructureProbe {
  probe(): Promise<InfrastructureProbeResult>;
}

/** The project store's view of infrastructure halts. ProjectHaltRepository satisfies it. */
export interface InfrastructureHalts {
  /** Projects blocked with category 'infrastructure' whose halt report is posted, oldest first. */
  listInfrastructureHalted(): Promise<ProjectId[]>;
  /**
   * Ends the project's infrastructure halt with the probe's evidence and returns it to work;
   * "moved" when it is not so halted any more, "unreported" when its halt report is not yet posted.
   */
  resumeFromInfrastructureHalt(projectId: ProjectId, evidence: string): Promise<"resumed" | "moved" | "unreported">;
}

/** Returns how many projects resumed this cycle. */
export async function resumeInfrastructureHalts(halts: InfrastructureHalts, probe: InfrastructureProbe): Promise<number> {
  const halted = await halts.listInfrastructureHalted();
  if (halted.length === 0) return 0;
  let result: InfrastructureProbeResult;
  try {
    result = await probe.probe();
  } catch (err) {
    result = { passed: false, evidence: `the probe itself threw: ${describeErrorChain(err)}` };
  }
  if (!result.passed) {
    console.warn(`[infrastructure] ${halted.length} project(s) stay halted, the substrate probe failed: ${result.evidence}`);
    return 0;
  }
  let resumed = 0;
  for (const projectId of halted) {
    const outcome = await halts.resumeFromInfrastructureHalt(projectId, result.evidence);
    if (outcome === "resumed") {
      resumed++;
      console.log(`[infrastructure] project ${projectId} resumed, the substrate probe passed: ${result.evidence}`);
    } else if (outcome === "unreported") {
      console.warn(`[infrastructure] project ${projectId} not resumed yet: its halt report is not posted, so it stays halted until the client is told`);
    } else {
      console.warn(`[infrastructure] project ${projectId} not resumed: it is no longer halted on infrastructure`);
    }
  }
  return resumed;
}

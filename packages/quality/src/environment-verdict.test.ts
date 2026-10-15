import { describe, expect, it } from "vitest";
import type { EnvironmentCheckReport, EnvironmentTestRun } from "@ashara/execution-infra";
import { wholeText } from "@ashara/shared";
import { environmentCheckVerdict } from "./environment-verdict.js";

// build_environment shows the environment role's model Quality's verdict on its work: the version,
// the image build's log and the probe's output, and a failure it can act on.
describe("environmentCheckVerdict", () => {
  const empty = wholeText("");
  const probe: EnvironmentTestRun = { command: "echo ok", exitCode: 0, timedOut: false, stdout: wholeText("ok\n"), stderr: empty };
  const tested: EnvironmentCheckReport = {
    kind: "tested",
    version: "v".repeat(64),
    imageRef: "localhost/ashara-env-p:vvvv",
    build: { kind: "built", log: wholeText("STEP 1/1: FROM base") },
    probe,
  };

  it("passes a tested environment whose probe printed, with the version, the build log and the probe's output", () => {
    const verdict = environmentCheckVerdict(tested);
    expect(verdict.passed).toBe(true);
    expect(verdict.report).toContain(`Environment version ${"v".repeat(64)}`);
    expect(verdict.report).toContain("Probe stdout:\nok");
    expect(verdict.report).toContain("Verdict: PASSED");
  });

  it("fails a probe that prints nothing, out-of-scope work and a failed build, saying what failed", () => {
    const silent: EnvironmentCheckReport = { ...tested, probe: { ...probe, stdout: empty } };
    const outside: EnvironmentCheckReport = { kind: "out_of_scope", recipe: ["environment/environment.toml"], paths: ["src/x"] };
    const failed: EnvironmentCheckReport = {
      kind: "build_failed",
      version: "v".repeat(64),
      detail: "podman build exited 1",
      log: [{ kind: "cut", chars: 120 }, { kind: "kept", text: "Error: no such image" }],
    };
    for (const [report, expected] of [
      [silent, "FAILED: the probe command printed nothing"],
      [outside, "- src/x"],
      [failed, "Image build log:\n[truncated by Ashara: 120 characters cut here]\nError: no such image"],
    ] as const) {
      const verdict = environmentCheckVerdict(report);
      expect(verdict.passed).toBe(false);
      expect(verdict.report).toContain(expected);
    }
  });
});

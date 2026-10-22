import { describe, expect, it } from "vitest";
import { attemptGrantOf } from "./attempt-grant.js";
import { UNKINDED_WORK_CHARTER, charterOf } from "./charter.js";
import { WORK_KINDS } from "./work-kind.js";
import type { WorkKind } from "./work-kind.js";

const CONVENTIONS = { publicInterfaceFile: "INTERFACE.txt" };

const EXPECTED_PROFILE: Readonly<Record<WorkKind, string>> = {
  environment: "build-environment",
  check: "define-checks",
  implementation: "run-and-dispute-checks",
};

describe("attemptGrantOf", () => {
  it("grants every kind of work its tool profile and the charter of the role that owns it", () => {
    for (const kind of WORK_KINDS) {
      const grant = attemptGrantOf(kind, CONVENTIONS);
      expect(grant.toolProfile, kind).toBe(EXPECTED_PROFILE[kind]);
      expect(grant.charter, kind).toEqual(charterOf(kind, CONVENTIONS));
    }
  });

  it("grants a task with no recorded kind the stored checks alone, under no role's further duties", () => {
    expect(attemptGrantOf(null, CONVENTIONS)).toEqual({ toolProfile: "run-checks", charter: UNKINDED_WORK_CHARTER });
  });
});

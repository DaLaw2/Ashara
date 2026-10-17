import { describe, expect, it } from "vitest";
import { parseProjectId } from "@ashara/shared";
import { type CapabilityClass, type Role, type Roster, validateRoster } from "./roster.js";

function role(id: string, ...capabilities: [CapabilityClass, ...CapabilityClass[]]): Role {
  return { id, name: id, responsibility: `${id} duties`, capabilities };
}

const liaison = role("liaison", "client-comms");
const platform = role("platform", "write-environment");
const implementer = role("implementer", "write-source");
const checkAuthor = role("check-author", "author-checks");

function roster(...roles: [Role, ...Role[]]): Roster {
  return { projectId: parseProjectId("00000000-0000-4000-8000-000000000001", "test"), visionVersion: 1, revision: 1, roles };
}

describe("validateRoster", () => {
  it("accepts a roster that gives each capability to one role", () => {
    expect(validateRoster(roster(liaison, platform, implementer, checkAuthor))).toEqual([]);
  });

  it("rejects one role holding write-source and author-checks", () => {
    const both = role("dev", "write-source", "author-checks");
    expect(validateRoster(roster(liaison, platform, both))).toEqual([
      {
        kind: "conflicting-capabilities",
        role: { id: "dev", name: "dev" },
        capabilities: ["write-source", "author-checks"],
      },
    ]);
  });

  it("rejects two roles holding write-environment", () => {
    const ops = role("ops", "write-environment");
    expect(validateRoster(roster(liaison, platform, ops, implementer, checkAuthor))).toEqual([
      {
        kind: "capability-held-by-several",
        capability: "write-environment",
        roles: [
          { id: "platform", name: "platform" },
          { id: "ops", name: "ops" },
        ],
      },
    ]);
  });

  it("rejects an empty roster rather than reading it as valid", () => {
    // @ts-expect-error the type forbids it; the runtime must still fail closed
    expect(validateRoster({ ...roster(liaison), roles: [] })).toEqual([{ kind: "empty-roster" }]);
  });

  it("rejects every unheld capability", () => {
    expect(validateRoster(roster(implementer))).toEqual([
      { kind: "capability-unheld", capability: "client-comms" },
      { kind: "capability-unheld", capability: "author-checks" },
      { kind: "capability-unheld", capability: "write-environment" },
    ]);
  });

  it("rejects two client-comms holders", () => {
    const second = role("second-liaison", "client-comms");
    expect(validateRoster(roster(liaison, second, platform, implementer, checkAuthor))).toEqual([
      expect.objectContaining({ kind: "capability-held-by-several", capability: "client-comms" }),
    ]);
  });

  it("rejects a client-comms holder that also holds other capabilities", () => {
    const talker = role("talker", "client-comms", "write-source");
    expect(validateRoster(roster(talker, platform, checkAuthor))).toEqual([
      { kind: "client-comms-not-exclusive", role: { id: "talker", name: "talker" }, otherCapabilities: ["write-source"] },
    ]);
  });

  it("rejects write-environment held together with author-checks", () => {
    const gatekeeper = role("gatekeeper", "write-environment", "author-checks");
    expect(validateRoster(roster(liaison, gatekeeper, implementer))).toEqual([
      {
        kind: "conflicting-capabilities",
        role: { id: "gatekeeper", name: "gatekeeper" },
        capabilities: ["write-environment", "author-checks"],
      },
    ]);
  });

  it("rejects two roles sharing an id", () => {
    const twin = { ...role("implementer", "author-checks"), name: "reviewer" };
    expect(validateRoster(roster(liaison, platform, implementer, twin))).toEqual([
      {
        kind: "duplicate-role-id",
        id: "implementer",
        roles: [
          { id: "implementer", name: "implementer" },
          { id: "implementer", name: "reviewer" },
        ],
      },
    ]);
  });

  it("rejects a role with no capabilities rather than reading it as harmless", () => {
    // @ts-expect-error the type forbids it; the runtime must still fail closed
    const idle: Role = { id: "idle", name: "idle", responsibility: "nothing", capabilities: [] };
    expect(validateRoster(roster(liaison, platform, implementer, checkAuthor, idle))).toEqual([
      { kind: "role-without-capabilities", role: { id: "idle", name: "idle" } },
    ]);
  });

  it("rejects duplicate role names, ignoring case and surrounding space", () => {
    const twin = { ...role("implementer-2", "write-source"), name: " Implementer " };
    expect(validateRoster(roster(liaison, platform, implementer, twin, checkAuthor))).toEqual([
      {
        kind: "duplicate-role-name",
        name: "implementer",
        roles: [
          { id: "implementer", name: "implementer" },
          { id: "implementer-2", name: " Implementer " },
        ],
      },
    ]);
  });
});

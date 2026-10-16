import { describe, expect, test, vi } from "vitest";
import { memoryStepContainment, parseProjectId } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { SchemaValidationError } from "./acl/finance-acl.js";
import type { ContextualLlm } from "./acl/finance-acl.js";
import type { ProjectBlockCause } from "./project-halt.js";
import { planningVisionOf } from "./acl/engagement-acl.js";
import { FirstPlanner } from "./first-plan.js";
import type { FirstPlanStore } from "./first-plan.js";

function roleRow(roleId: string, name: string, capabilities: string[]) {
  return { revision: 1, visionVersion: 1, roleId, name, responsibility: `${name} duties`, capabilities };
}

const ROSTER_ROWS = [
  roleRow("00000000-0000-4000-8000-0000000000a1", "Liaison", ["client-comms"]),
  roleRow("00000000-0000-4000-8000-0000000000a2", "Platform", ["write-environment"]),
  roleRow("00000000-0000-4000-8000-0000000000a3", "Implementer", ["write-source"]),
  roleRow("00000000-0000-4000-8000-0000000000a4", "Check author", ["author-checks"]),
];

function awaiting(
  projectId: ProjectId,
  planLastError: string | null,
  planAttempts = 3,
  rosterRows: unknown = ROSTER_ROWS,
  scopeBoundaries: unknown = ["In: booking a class"],
  inferences: unknown = [],
) {
  return {
    projectId,
    projectName: "Studio booking",
    vision: { projectId, version: 1, visionText: "A booking page.", summary: "A booking page.", scopeBoundaries, inferences, openQuestions: [] },
    planAttempts,
    planLastError,
    rosterRows,
  };
}

const notReached = async (): Promise<never> => {
  throw new Error("must not be reached");
};

type Blocked = Array<{ projectId: ProjectId; cause: ProjectBlockCause }>;

function storeWith(projects: ReturnType<typeof awaiting>[], blocked: Blocked, stopped: ProjectId[] = []): FirstPlanStore {
  return {
    projectsAwaitingPlan: async () => projects,
    writeFirstPlan: notReached,
    recordFailedAttempt: notReached,
    stopPlanning: async (projectId) => {
      stopped.push(projectId);
    },
    blockProject: async (projectId, cause) => {
      blocked.push({ projectId, cause });
      return "blocked";
    },
  };
}

const llm: ContextualLlm = { forCall: () => ({ generateStructured: notReached }) };

describe("FirstPlanner per-project failure", () => {
  test("a project at its cap with no recorded error is blocked and the next project is still stopped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const lying = parseProjectId("00000000-0000-4000-8000-000000000020", "test");
    const capped = parseProjectId("00000000-0000-4000-8000-000000000021", "test");
    const blocked: Blocked = [];
    const stopped: ProjectId[] = [];
    const store = storeWith([awaiting(lying, null), awaiting(capped, "Error: decomposition failed")], blocked, stopped);

    const outcomes = await new FirstPlanner({ containment: memoryStepContainment(() => true), llm, store }).runPending();

    expect(outcomes.map((o) => `${o.projectId}:${o.kind}`)).toEqual([`${lying}:project-blocked`, `${capped}:stopped`]);
    expect(blocked).toEqual([
      { projectId: lying, cause: { category: "fault", errorClass: "PlanFailureUnrecorded", reason: expect.stringMatching(/^PlanFailureUnrecorded: /) } },
    ]);
    expect(stopped).toEqual([capped]);
  });

  test("a roster that gives implementation work two owners blocks the project before any model call", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const projectId = parseProjectId("00000000-0000-4000-8000-000000000022", "test");
    const twoImplementers = [...ROSTER_ROWS, roleRow("00000000-0000-4000-8000-0000000000a5", "Second", ["write-source"])];
    const blocked: Blocked = [];
    const store = storeWith([awaiting(projectId, null, 0, twoImplementers)], blocked);

    const outcomes = await new FirstPlanner({ containment: memoryStepContainment(() => true), llm, store }).runPending();

    expect(outcomes.map((o) => o.kind)).toEqual(["project-blocked"]);
    expect(blocked[0]?.cause.errorClass).toBe("RosterUnreadable");
    expect(blocked[0]?.cause.reason).toMatch(/"write-source".*several roles \("Implementer", "Second"\)/);
  });
});

describe("FirstPlanner decomposition ladder", () => {
  test("a model that never validates is asked 2 times per tier on 2 tiers before the plan attempt fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const capabilities: string[] = [];
    const failing: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          capabilities.push(request.capability);
          throw new SchemaValidationError(["scripted failure"], null);
        },
      }),
    };
    const projectId = parseProjectId("00000000-0000-4000-8000-000000000023", "test");
    const store: FirstPlanStore = { ...storeWith([awaiting(projectId, null, 0)], []), recordFailedAttempt: async () => 1 };

    const outcomes = await new FirstPlanner({ containment: memoryStepContainment(() => true), llm: failing, store }).runPending();

    expect(outcomes.map((o) => o.kind)).toEqual(["failed"]);
    expect(capabilities).toEqual(["Strong", "Strong", "Frontier", "Frontier"]);
  });
});

/** A stored vision version, as the store hands it over, with what planning reads of it varied. */
function stored(projectId: ProjectId, version: number, summary: string, scopeBoundaries: unknown, inferences: unknown) {
  return { projectId, version, visionText: summary, summary, scopeBoundaries, inferences, openQuestions: [] };
}

const visionItemsOf = (vision: ReturnType<typeof stored>) => planningVisionOf(vision).items;
const northStarOf = (vision: ReturnType<typeof stored>) => planningVisionOf(vision).northStar;

describe("the vision items a plan traces to (ADR-074 addendum 2 d71 d)", () => {
  test("each scope boundary and each assumption is an item; a Stated one by the decision the answer made", () => {
    const projectId = parseProjectId("00000000-0000-4000-8000-000000000024", "test");
    const items = visionItemsOf(
      stored(projectId, 2, "A booking page.", ["In: booking", "Out: payments"], [
        { statement: "Classes hold twenty", status: "Inferred" },
        { statement: "Bookings close an hour before", status: "Stated", clientAnswer: { messageId: "m1", question: "When?", answer: "An hour before" } },
      ]),
    );

    // Records written before kinds: placed by order, unclassified, standing with the client unrecorded.
    expect(items).toEqual([
      { type: "scope", id: "S1", text: "In: booking", side: "unclassified" },
      { type: "scope", id: "S2", text: "Out: payments", side: "unclassified" },
      { type: "assumption", id: "A1", text: "Classes hold twenty", status: "Inferred", standing: "unrecorded", kind: "unclassified" },
      { type: "assumption", id: "A2", text: "Bookings close an hour before", status: "Stated", standing: "stated", kind: "unclassified" },
    ]);
  });

  // ADR-074 addendum 2 d89: an assumption is cited by its key in the vision, with its kind and standing.
  test("an assumption is the item of its key, with the kind and standing its record holds; a repeated key is refused", () => {
    const projectId = parseProjectId("00000000-0000-4000-8000-000000000025", "test");
    const reading = (inferences: unknown) => stored(projectId, 3, "A store.", ["In: put"], inferences);
    expect(
      visionItemsOf(
        reading([
          { key: "A1", statement: "Values are one word", status: "Inferred", kind: "client-visible", disclosed: "asked" },
          { key: "A7", statement: "The log is wal.log", status: "Inferred", kind: "internal-design", disclosed: "reported" },
        ]),
      ),
    ).toEqual([
      { type: "scope", id: "S1", text: "In: put", side: "unclassified" },
      { type: "assumption", id: "A1", text: "Values are one word", status: "Inferred", standing: "asked", kind: "client-visible" },
      { type: "assumption", id: "A7", text: "The log is wal.log", status: "Inferred", standing: "reported", kind: "internal-design" },
    ]);
    expect(() =>
      visionItemsOf(
        reading([
          { key: "A1", statement: "x", status: "Inferred", kind: "client-visible" },
          { key: "A1", statement: "y", status: "Inferred", kind: "client-visible" },
        ]),
      ),
    ).toThrow(/two assumptions share the key A1/);
  });

  // A scope line keeps the side intake recorded, and a disclosure that
  // is neither value is an unreadable vision, never an assumption the client was not shown.
  test("a scope line carries its recorded side, and a malformed disclosure makes the vision unreadable", () => {
    const projectId = parseProjectId("00000000-0000-4000-8000-000000000025", "test");
    const reading = (inferences: unknown) =>
      stored(projectId, 2, "A store.", [{ text: "put and get", side: "in" }, { text: "any network service", side: "out" }], inferences);
    expect(visionItemsOf(reading([])).map((item) => (item.type === "scope" ? [item.id, item.side] : []))).toEqual([
      ["S1", "in"],
      ["S2", "out"],
    ]);
    expect(northStarOf(reading([]))).toContain("- In scope: put and get\n- Out of scope: any network service");
    expect(() =>
      visionItemsOf(reading([{ key: "A1", statement: "x", status: "Inferred", kind: "client-visible", disclosed: "emailed" }])),
    ).toThrow(/inferences is not in a readable shape/);
  });

  // Planning #21: the stored vision cannot change between attempts, so an unreadable one is the
  // project's record, blocked at once, never counted and retried as a failed plan attempt.
  test("an unreadable vision blocks the project with VisionUnreadable; no attempt is counted, no model called", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const projectId = parseProjectId("00000000-0000-4000-8000-000000000026", "test");
    const blocked: Blocked = [];
    const unreadable = awaiting(projectId, null, 0, ROSTER_ROWS, ["In: booking a class"], [
      { key: "A1", statement: "x", status: "Inferred", kind: "client-visible", disclosed: "emailed" },
    ]);
    const store: FirstPlanStore = { ...storeWith([], blocked), projectsAwaitingPlan: async () => [unreadable] };

    const outcomes = await new FirstPlanner({ containment: memoryStepContainment(() => true), llm, store }).runPending();

    expect(outcomes.map((o) => o.kind)).toEqual(["project-blocked"]);
    expect(blocked[0]?.cause).toMatchObject({ category: "fault", errorClass: "VisionUnreadable" });
  });

  test("a vision with no item blocks the project with VisionItemsMissing before any model call; no attempt is counted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const projectId = parseProjectId("00000000-0000-4000-8000-000000000025", "test");
    const blocked: Blocked = [];
    const store: FirstPlanStore = {
      ...storeWith([awaiting(projectId, null, 0, ROSTER_ROWS, [])], blocked),
      recordFailedAttempt: async () => {
        throw new Error("recordFailedAttempt must not be reached: the vision is the project's record");
      },
    };

    const outcomes = await new FirstPlanner({ containment: memoryStepContainment(() => false), llm, store }).runPending();

    expect(outcomes.map((o) => o.kind)).toEqual(["project-blocked"]);
    expect(blocked[0]?.cause).toMatchObject({ category: "fault", errorClass: "VisionItemsMissing" });
  });

  test("a fault nothing names in the planning call is Ashara's: contained to the project, never counted toward the stop", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const projectId = parseProjectId("00000000-0000-4000-8000-000000000027", "test");
    const store: FirstPlanStore = {
      ...storeWith([awaiting(projectId, null, 0)], []),
      recordFailedAttempt: async () => {
        throw new Error("recordFailedAttempt must not be reached: the plan is not at fault");
      },
    };
    const broken: ContextualLlm = {
      forCall: () => ({
        generateStructured: async () => {
          throw new TypeError("Cannot read properties of undefined (reading 'content')");
        },
      }),
    };
    const containment = memoryStepContainment(() => false);

    const outcomes = await new FirstPlanner({ containment, llm: broken, store }).runPending();

    expect(outcomes).toEqual([expect.objectContaining({ kind: "step-faulted", step: "first-plan", subjectId: projectId, error: expect.stringContaining("Cannot read properties") })]);
    expect(containment.recorded.get(`first-plan/${projectId}`)).toMatchObject({ faults: 1 });
  });
});

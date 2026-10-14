import { describe, expect, test, vi } from "vitest";
import { SchemaValidationError } from "@ashara/llm-gateway";
import type { ContextualLlm } from "@ashara/llm-gateway";
import { parseProjectId } from "@ashara/shared";
import type { ProjectBlockCause, ProjectId } from "@ashara/shared";
import { FirstPlanner, visionItemsOf } from "./first-plan.js";
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
) {
  return {
    projectId,
    projectName: "Studio booking",
    visionVersion: 1,
    visionText: "A booking page.",
    summary: "A booking page.",
    scopeBoundaries,
    inferences: [],
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

    const outcomes = await new FirstPlanner({ llm, store }).runPending();

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

    const outcomes = await new FirstPlanner({ llm, store }).runPending();

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

    const outcomes = await new FirstPlanner({ llm: failing, store }).runPending();

    expect(outcomes.map((o) => o.kind)).toEqual(["failed"]);
    expect(capabilities).toEqual(["Strong", "Strong", "Frontier", "Frontier"]);
  });
});

describe("the vision items a plan traces to (ADR-074 addendum 2 d71 d)", () => {
  test("each scope boundary and each assumption is an item; a Stated one by the decision the answer made", () => {
    const projectId = parseProjectId("00000000-0000-4000-8000-000000000024", "test");
    const items = visionItemsOf({
      projectId,
      visionVersion: 2,
      summary: "A booking page.",
      scopeBoundaries: ["In: booking", "Out: payments"],
      inferences: [
        { statement: "Classes hold twenty", status: "Inferred" },
        { statement: "Bookings close an hour before", status: "Stated", clientAnswer: { question: "When?", answer: "An hour before" } },
      ],
    });

    // Records written before kinds: placed by order, unclassified, never shown to the client.
    expect(items).toEqual([
      { type: "scope", id: "S1", text: "In: booking" },
      { type: "scope", id: "S2", text: "Out: payments" },
      { type: "assumption", id: "A1", text: "Classes hold twenty", status: "Inferred", standing: "not-shown", kind: "unclassified" },
      { type: "assumption", id: "A2", text: "Bookings close an hour before", status: "Stated", standing: "stated", kind: "unclassified" },
    ]);
  });

  // ADR-074 addendum 2 d89: an assumption is cited by its key in the vision, with its kind and standing.
  test("an assumption is the item of its key, with the kind and standing its record holds; a repeated key is refused", () => {
    const projectId = parseProjectId("00000000-0000-4000-8000-000000000025", "test");
    const reading = (inferences: unknown) => ({ projectId, visionVersion: 3, summary: "A store.", scopeBoundaries: ["In: put"], inferences });
    expect(
      visionItemsOf(
        reading([
          { key: "A1", statement: "Values are one word", status: "Inferred", kind: "client-visible", disclosed: "asked" },
          { key: "A7", statement: "The log is wal.log", status: "Inferred", kind: "internal-design", disclosed: "reported" },
        ]),
      ),
    ).toEqual([
      { type: "scope", id: "S1", text: "In: put" },
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

  test("a vision with no item fails the plan attempt before any model call", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const projectId = parseProjectId("00000000-0000-4000-8000-000000000025", "test");
    const errors: string[] = [];
    const store: FirstPlanStore = {
      ...storeWith([awaiting(projectId, null, 0, ROSTER_ROWS, [])], []),
      recordFailedAttempt: async (_projectId, error) => {
        errors.push(error);
        return 1;
      },
    };

    const outcomes = await new FirstPlanner({ llm, store }).runPending();

    expect(outcomes.map((o) => o.kind)).toEqual(["failed"]);
    expect(errors[0]).toMatch(/^VisionItemsMissing: /);
  });
});

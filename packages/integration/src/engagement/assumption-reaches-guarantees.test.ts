import { describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { replanStoreSuite } from "../server/replan-store-suite.js";

// An answer that amends only an assumption holds and replans the work citing a guarantee resting on
// it. The rows, stores and scripted model are the shared plan revision fixture's
// (replan-store-suite.ts); no real LLM call is made.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const suite = replanStoreSuite(stub);
const { pipelineModel, replanner, plannedProject, contradict, itemsOf, projectRow } = suite;

/** Two tender guarantees: G2 rests on the question's assumption A1, G1 on none. */
const RESTING_INTAKE = {
  summary: "A booking page for the client's two pottery studios.",
  interface: [{ id: "I1", text: "The booking page.", source: { kind: "tender", quote: "Booking page" } }],
  guarantees: [
    {
      id: "G1",
      statement: "A client books a class at either studio.",
      observable: { interface: ["I1"], observation: "output" },
      refutedBy: ["A booking at either studio is refused."],
      source: { kind: "tender", quote: "Booking page for my two pottery studios." },
    },
    {
      id: "G2",
      statement: "The page lists the first studio's classes first.",
      observable: { interface: ["I1"], observation: "output" },
      refutedBy: ["The page lists another studio's classes first."],
      source: { kind: "tender", quote: "Booking page" },
    },
  ],
  assumptions: [],
  questions: [
    {
      text: "Which studio opens first?",
      whyItMatters: "It orders the work.",
      assumption: { id: "A1", statement: "The harbour studio opens first.", rationale: "The tender names it first.", kind: "client-visible", underpins: ["G2"] },
    },
  ],
  exclusions: [],
};

/** A first plan with one task citing only G2, which rests on A1, and one citing only G1, which rests on nothing. */
const TASK_PER_GUARANTEE = {
  tasks: [
    {
      ref: "t1", title: "List the first studio first", description: "Studio order.", dependsOn: [], goal: "",
      endState: "The first studio's classes are listed first", scope: "studio order", deliverables: [{ text: "studio order", sources: ["G2"] }], acceptance: [{ text: "a client sees the first studio first", sources: ["G2"] }],
      capability: "Medium", capabilityReason: "graded for the test",
    },
    {
      ref: "t2", title: "Book a class", description: "Bookings.", dependsOn: [], goal: "",
      endState: "A class can be booked", scope: "bookings", deliverables: [{ text: "booking", sources: ["G1"] }], acceptance: [{ text: "a client books a class", sources: ["G1"] }],
      capability: "Medium", capabilityReason: "graded for the test",
    },
  ],
};

describe("an amended assumption reaches every guarantee resting on it", () => {
  test("an answer amending only an assumption holds and replans a task citing only a guarantee resting on it", async () => {
    const { projectId, questionId } = await plannedProject({ reported: true, intake: RESTING_INTAKE, firstTasks: TASK_PER_GUARANTEE });
    const first = await itemsOf(projectId);
    const order = first.find((i) => i.title === "List the first studio first");
    const booking = first.find((i) => i.title === "Book a class");
    if (order === undefined || booking === undefined) throw new Error("the first plan holds no task per guarantee");

    const answerId = await contradict(projectId, questionId);

    const holds = await suite.db.execute(sql`SELECT requested_by AS "requestedBy", affected FROM correction_holds WHERE project_id = ${projectId}`);
    expect(holds.rows).toEqual([{ requestedBy: answerId, affected: ["A1", "G2"] }]);
    expect((await projectRow(projectId)).awaiting).toEqual([answerId]);
    // G1 rests on no amended assumption: the task citing it alone is not held.
    expect((await itemsOf(projectId)).find((i) => i.id === booking.id)).toMatchObject({ status: "Pending", reason: null });

    pipelineModel({ environmentChange: false });
    expect((await replanner().runPending()).map((o) => o.kind)).toEqual(["revised"]);
    expect((await itemsOf(projectId)).find((i) => i.id === order.id)).toMatchObject({
      status: "Abandoned",
      reason: { source: "superseded", planRevision: 2, requestedBy: answerId },
    });
    expect((await projectRow(projectId)).awaiting).toEqual([]);
  });
});

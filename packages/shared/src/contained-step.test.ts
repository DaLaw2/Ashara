import { describe, expect, test, vi } from "vitest";
import { containEach, memoryStepContainment } from "./contained-step.js";
import { parseProjectId } from "./ids.js";

class Escaping extends Error {}

const projectA = parseProjectId("00000000-0000-4000-8000-00000000000a", "test");
const projectB = parseProjectId("00000000-0000-4000-8000-00000000000b", "test");
const subjects = [
  { id: "a", projectId: projectA },
  { id: "b", projectId: projectB },
];

describe("containEach", () => {
  test("a subject that throws is recorded and backed off, and the step goes on with the next", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const containment = memoryStepContainment((error) => error instanceof Escaping);
    const run = async (subject: { id: string }) => {
      if (subject.id === "a") throw new TypeError("a fault nothing names");
      return subject.id;
    };

    const outcomes = await containEach(containment, "roster", subjects, (s) => s, run);

    expect(outcomes).toEqual([
      { kind: "step-faulted", step: "roster", subjectId: "a", projectId: projectA, faults: 1, retryAfterSeconds: 60, error: expect.stringContaining("a fault nothing names") },
      "b",
    ]);
    expect(containment.recorded.get("roster/a")).toMatchObject({ faults: 1 });
    // Waiting out its backoff, the subject is skipped; the other still runs.
    expect(await containEach(containment, "roster", subjects, (s) => s, run)).toEqual(["b"]);
  });

  test("a subject past its backoff runs again: a second fault doubles the wait, a run that completes clears it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const containment = memoryStepContainment(() => false);
    const [first] = subjects;
    if (first === undefined) throw new Error("no subject");
    let fails = true;
    const run = async () => {
      if (fails) throw new Error("scripted");
      return "ran";
    };
    // A fault on record whose backoff has already passed.
    const seedDue = () => containment.record({ step: "acceptance", subjectId: "a", projectId: projectA, error: "seed", retryAfterSeconds: -1 });

    await seedDue();
    expect(await containEach(containment, "acceptance", [first], (s) => s, run)).toEqual([expect.objectContaining({ kind: "step-faulted", faults: 2, retryAfterSeconds: 120 })]);
    await seedDue();
    fails = false;
    expect(await containEach(containment, "acceptance", [first], (s) => s, run)).toEqual(["ran"]);
    expect(containment.recorded.size).toBe(0);
  });

  test("an escaping error throws through, unrecorded, and stops the step", async () => {
    const containment = memoryStepContainment((error) => error instanceof Escaping);
    const refusal = new Escaping("the cap");
    const ran: string[] = [];

    await expect(
      containEach(containment, "first-plan", subjects, (s) => s, async (subject) => {
        ran.push(subject.id);
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(ran).toEqual(["a"]);
    expect(containment.recorded.size).toBe(0);
  });

  test("a ledger that cannot record the fault throws through: a fault is never dropped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const memory = memoryStepContainment(() => false);
    const broken = { ...memory, record: async () => Promise.reject(new Error("ledger down")) };

    await expect(containEach(broken, "replan", subjects, (s) => s, async () => Promise.reject(new Error("scripted")))).rejects.toThrow("ledger down");
  });
});

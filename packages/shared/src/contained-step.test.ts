import { describe, expect, test, vi } from "vitest";
import { UnreadSubject, containEach, memoryStepContainment, readEach, uncontainedSteps } from "./contained-step.js";
import { parseProjectId } from "./ids.js";
import { recordingLogger } from "./log.js";

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

  test("each subject's run is scoped on the containment's logger: its records carry its project and subject, in the enclosing trace", async () => {
    const logger = recordingLogger();
    const containment = { ...memoryStepContainment(() => false), logger };
    await logger.scope({ cycle: 7, trace: "new" }, () =>
      containEach(containment, "roster", subjects, (s) => s, async (subject) => logger.info("test.subject-ran", subject.id)),
    );

    expect(logger.records.map(({ projectId, subject, cycle }) => ({ projectId, subject, cycle }))).toEqual([
      { projectId: projectA, subject: "a", cycle: 7 },
      { projectId: projectB, subject: "b", cycle: 7 },
    ]);
    expect(new Set(logger.records.map((record) => record.traceId)).size).toBe(1);
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

  test("a subject that keeps failing halts its project on Ashara's own fault, and only past the bound", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const containment = memoryStepContainment(() => false);
    const [first] = subjects;
    if (first === undefined) throw new Error("no subject");
    const fail = async (): Promise<string> => Promise.reject(new TypeError("always"));
    const faultAgain = async () => {
      await containment.record({ step: "gate", subjectId: "a", projectId: projectA, error: "seed", retryAfterSeconds: -1 });
      return containEach(containment, "gate", [first], (s) => s, fail);
    };

    for (let fault = 2; fault < 6; fault += 2) await faultAgain();
    expect(containment.halted).toEqual([]);
    await faultAgain();
    expect(containment.halted).toEqual([{ projectId: projectA, fault: expect.objectContaining({ name: "StepFaultsExhausted", faults: 6, subjectId: "a" }) }]);
  });

  test("a subject of a project already halted ends parked at the bound: recorded, not tried while its project is not at work, tried again once it is", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const containment = memoryStepContainment(() => false);
    containment.notAtWork.add(projectA);
    const [first] = subjects;
    if (first === undefined) throw new Error("no subject");
    let runs = 0;
    const fail = async (): Promise<string> => {
      runs += 1;
      return Promise.reject(new TypeError("always"));
    };
    // Six faults on record, the last one's backoff passed: the next fault passes the bound on a project already halted.
    for (let fault = 0; fault < 6; fault += 1) {
      await containment.record({ step: "block-report", subjectId: "a", projectId: projectA, error: "seed", retryAfterSeconds: -1 });
    }
    await containEach(containment, "block-report", [first], (s) => s, fail);
    expect(containment.halted).toEqual([]);
    expect(containment.recorded.get("block-report/a")).toMatchObject({ faults: 7, parked: true });
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/already halted.*parked in step_faults.*scripts\/project\.ts unblock/));

    // Its backoff passes, and it is still not tried while its project is halted.
    await containment.record({ step: "block-report", subjectId: "a", projectId: projectA, error: "seed", retryAfterSeconds: -1 });
    expect(await containEach(containment, "block-report", [first], (s) => s, fail)).toEqual([]);
    expect(runs).toBe(1);

    containment.notAtWork.delete(projectA);
    expect(await containEach(containment, "block-report", [first], (s) => s, async () => "ran")).toEqual(["ran"]);
    expect(containment.recorded.size).toBe(0);
  });

  test("a row a listing cannot read is its subject's fault: recorded on it like a failed run, and every other row is still read and run", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const containment = memoryStepContainment(() => false);
    const rows = [{ id: "a", projectId: projectA, spend: "not an amount" }, { id: "b", projectId: projectB, spend: "1" }];
    const listed = await readEach(rows, (row) => row, (row) => {
      if (!/^\d+$/.test(row.spend)) throw new TypeError(`spend of ${row.id} does not parse`);
      return { id: row.id, projectId: row.projectId, spend: Number(row.spend) };
    });

    expect(listed[0]).toBeInstanceOf(UnreadSubject);
    const outcomes = await containEach(containment, "block-report", listed, (s) => s, async (s) => s.spend);
    expect(outcomes).toEqual([expect.objectContaining({ kind: "step-faulted", subjectId: "a", projectId: projectA, error: expect.stringContaining("spend of a does not parse") }), 1]);
    expect(containment.recorded.get("block-report/a")).toMatchObject({ faults: 1 });
  });

  test("uncontained steps skip nothing and contain nothing", async () => {
    const thrown = new TypeError("first failure");
    await expect(containEach(uncontainedSteps(recordingLogger()), "block-report", subjects, (s) => s, async () => Promise.reject(thrown))).rejects.toBe(thrown);
  });
});


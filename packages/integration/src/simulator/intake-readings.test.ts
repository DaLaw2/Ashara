import { describe, expect, it } from "vitest";
import { lazyIntakes } from "./intake-readings.js";
import type { IntakeRecords, ObservedIntake } from "./intake-readings.js";

// I3's intake clause, judged on the stand-ins' observations against the records.
// The expected records are written here, never read from production.
const P = "p1";
const reading = (questions: number, model = "big"): ObservedIntake => ({ projectId: P, kind: "reading", provider: "sim", model, questions });
const asked = (model: string): ObservedIntake => ({ projectId: P, kind: "second-asked", provider: "sim", model, questions: 0 });
const answered = (model: string, questions: number): ObservedIntake => ({ projectId: P, kind: "second-answered", provider: "sim", model, questions });

function records(row: Partial<NonNullable<IntakeRecords["reading"]>> | null, questionsPosted: number): IntakeRecords {
  return {
    visionWritten: true,
    reading: row === null ? null : { firstProvider: "sim", firstModel: "big", firstQuestions: 0, confirmation: "not-needed", secondStrength: null, secondQuestions: null, ...row },
    questionsPosted,
  };
}

const keys = (found: ReadonlyArray<{ readonly key: string }>): string[] => found.map((each) => each.key);

describe("a tender reading that asks nothing is held to a second reading", () => {
  it("names a reading that asked nothing and was put to no second reading, as when the empty list is read as an unambiguous tender", () => {
    expect(keys(lazyIntakes(P, records(null, 0), [reading(0)]))).toEqual(["lazy-intake"]);
    // A second reading of another project's tender is not this one's.
    expect(keys(lazyIntakes(P, records(null, 0), [reading(0), { ...asked("small"), projectId: "p2" }]))).toEqual(["lazy-intake"]);
  });

  it("passes a second reading whose questions were posted and whose strength the record names", () => {
    const observed = [reading(0), asked("small"), answered("small", 1)];
    const row = { confirmation: "questions-raised", secondStrength: "same-family-other-model", secondQuestions: 1 };
    expect(lazyIntakes(P, records(row, 1), observed)).toEqual([]);
  });

  it("names a record whose strength or questions are not the second reading's", () => {
    const observed = [reading(0), asked("small"), answered("small", 1)];
    expect(keys(lazyIntakes(P, records({ confirmation: "questions-raised", secondStrength: "other-family", secondQuestions: 1 }, 1), observed))).toEqual(["intake-reading-record"]);
    expect(keys(lazyIntakes(P, records({ confirmation: "questions-raised", secondStrength: "same-family-other-model", secondQuestions: 1 }, 0), observed))).toEqual(["intake-questions"]);
  });

  it("holds a second reading that never answered whole to an unconfirmed record", () => {
    const observed = [reading(0), asked("small"), asked("big")];
    expect(lazyIntakes(P, records({ confirmation: "unconfirmed" }, 0), observed)).toEqual([]);
    expect(keys(lazyIntakes(P, records({ confirmation: "confirmed", secondStrength: "same-model", secondQuestions: 0 }, 0), observed))).toEqual(["intake-reading-record"]);
  });

  it("judges only the last reading, the one intake recorded, and nothing before the vision is written", () => {
    // An earlier reading lost to a crash asked nothing; the one recorded asked a question.
    expect(lazyIntakes(P, records({ firstQuestions: 1 }, 1), [reading(0), reading(1)])).toEqual([]);
    expect(lazyIntakes(P, { visionWritten: false, reading: null, questionsPosted: 0 }, [reading(0)])).toEqual([]);
  });

  it("names a reading the stand-ins could not attribute to a project", () => {
    expect(keys(lazyIntakes(P, records(null, 0), [{ ...reading(1), projectId: null }]))).toEqual(["intake-unattributed"]);
  });
});

import { describe, expect, test } from "vitest";
import { Vision, VisionChangeRefused, VisionUnreadable, assertVisionWritable, readVisionVersion } from "./vision.js";

const PROJECT = "00000000-0000-4000-8000-0000000000c1";
const stored = (inferences: unknown, extra: { scopeBoundaries?: unknown; openQuestions?: unknown } = {}) => ({
  projectId: PROJECT,
  version: 3,
  visionText: "A key-value store.",
  summary: "A store.",
  scopeBoundaries: extra.scopeBoundaries ?? [{ text: "put and get", side: "in" }],
  inferences,
  openQuestions: extra.openQuestions ?? [],
});

const asked = { key: "A1", statement: "Commands wait for the lock.", rationale: "tender", status: "Inferred", kind: "client-visible", disclosed: "asked" };
const internal = { key: "A4", statement: "The log is wal.log.", rationale: "simplest", status: "Inferred", kind: "internal-design", disclosed: "reported" };

describe("readVisionVersion: one reader for every context", () => {
  test("keyed records keep their keys, kinds and standings; a record without them reads unkeyed, unclassified, never shown", () => {
    const read = readVisionVersion(stored([asked, { statement: "Written before keys.", status: "Inferred" }]));
    expect(read.assumptions.map((a) => [a.id, a.keyed, a.kind, a.standing])).toEqual([
      ["A1", true, "client-visible", "asked"],
      ["A2", false, "unclassified", "not-shown"],
    ]);
    expect(read.scope).toEqual([{ text: "put and get", side: "in" }]);
  });

  test("the legacy direction map reads as unkeyed assumptions with no status; bare strings are unclassified scope and id-less questions", () => {
    const read = readVisionVersion(stored({ stack: "Go" }, { scopeBoundaries: ["In: put"], openQuestions: ["Which shell?"] }));
    expect(read.assumptions.map((a) => [a.id, a.keyed, a.status, a.statement])).toEqual([["A1", false, null, "stack: Go"]]);
    expect(read.scope).toEqual([{ text: "In: put", side: "unclassified" }]);
    expect(read.openQuestions).toEqual([{ messageId: null, text: "Which shell?", assumptionKey: null }]);
  });

  test.each([
    { case: "a disclosure that is neither asked nor reported", inferences: [{ ...asked, disclosed: "emailed" }] },
    { case: "a Stated record without the answer that stated it", inferences: [{ ...asked, status: "Stated" }] },
    { case: "two assumptions under one key", inferences: [asked, { ...internal, key: "A1" }] },
  ])("$case: VisionUnreadable, never a default", ({ inferences }) => {
    expect(() => readVisionVersion(stored(inferences))).toThrow(VisionUnreadable);
  });
});

describe("Vision: the only way a next version is composed", () => {
  test("appendInferred takes the next free key and keeps every stored record as written", () => {
    const change = Vision.read(stored([asked, internal])).appendInferred({
      statement: "Keys are ASCII.",
      rationale: "stack",
      kind: "client-visible",
      disclosed: "reported",
      changeReason: (key) => `adopted ${key}`,
    });
    expect([change.key, change.basedOnVersion, change.changeReason]).toEqual(["A5", 3, "adopted A5"]);
    expect(change.inferences.slice(0, 2)).toEqual([asked, internal]);
  });

  test("stateAssumption states the keyed record with the client's answer and closes its question; an unknown key is refused", () => {
    const vision = Vision.read(stored([asked, internal], { openQuestions: [{ messageId: "q1", text: "Wait?", assumptionKey: "A1" }] }));
    const answer = {
      messageId: "m1",
      questionMessageId: "q1",
      question: "Wait?",
      answer: "No, fail at once.",
      verdict: "changes" as const,
      statement: "Commands fail at once.",
      kind: null,
      rationale: "client answer",
      changeReason: "answered",
    };
    const change = vision.stateAssumption("A1", answer);
    expect(change.openQuestions).toEqual([]);
    expect(change.inferences[1]).toEqual(internal);
    const next = readVisionVersion({ ...stored(change.inferences), version: 4 });
    expect(next.assumptions[0]).toMatchObject({ id: "A1", status: "Stated", standing: "stated", statement: "Commands fail at once." });
    expect(next.assumptions[0]?.clientAnswer).toMatchObject({ messageId: "m1", verdict: "changes" });
    expect(() => vision.stateAssumption("A9", answer)).toThrow(VisionChangeRefused);
  });

  test("the legacy map takes no keyed change, and a version the reader would refuse is never written", () => {
    expect(() =>
      Vision.read(stored({ stack: "Go" })).appendInferred({ statement: "s", rationale: "r", kind: "client-visible", disclosed: "asked", changeReason: () => "c" }),
    ).toThrow(VisionChangeRefused);
    expect(() => assertVisionWritable(PROJECT, { scopeBoundaries: [], inferences: { stack: "Go" }, openQuestions: [] })).toThrow(/nothing was written/);
  });
});

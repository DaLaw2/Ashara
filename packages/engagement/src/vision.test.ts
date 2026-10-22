import { describe, expect, test } from "vitest";
import { basisOf } from "./vision-language/guarantee.js";
import { Vision, VisionChangeRefused, VisionUnreadable, readVisionVersion, visionWritable } from "./vision.js";

const PROJECT = "00000000-0000-4000-8000-0000000000c1";
const NO_CONTRACT = { contractForm: "scope-lines", interface: [], guarantees: [], exclusions: [] };
const stored = (inferences: unknown, extra: { scopeBoundaries?: unknown; openQuestions?: unknown } = {}) => ({
  projectId: PROJECT,
  version: 3,
  visionText: "A key-value store.",
  summary: "A store.",
  scopeBoundaries: extra.scopeBoundaries ?? [{ text: "put and get", side: "in" }],
  inferences,
  openQuestions: extra.openQuestions ?? [],
  ...NO_CONTRACT,
});

const asked = { key: "A1", statement: "Commands wait for the lock.", rationale: "tender", status: "Inferred", kind: "client-visible", disclosed: "asked" };
const internal = { key: "A4", statement: "The log is wal.log.", rationale: "simplest", status: "Inferred", kind: "internal-design", disclosed: "reported" };

describe("readVisionVersion: one reader for every context", () => {
  test("keyed records keep their keys, kinds and standings; a record without them reads unkeyed, unclassified, standing unrecorded", () => {
    const read = readVisionVersion(stored([asked, { statement: "Written before keys.", status: "Inferred" }]));
    expect(read.assumptions.map((a) => [a.id, a.keyed, a.kind, a.standing])).toEqual([
      ["A1", true, "client-visible", "asked"],
      ["A2", false, "unclassified", "unrecorded"],
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

describe("a version written before guarantees reads as legacy guarantees, never checkable as written", () => {
  test("in-scope and unclassified lines and every assumption not internal design are legacy guarantees; out-of-scope lines are exclusions", () => {
    const read = readVisionVersion(
      stored([asked, internal], { scopeBoundaries: [{ text: "put and get", side: "in" }, { text: "replication", side: "out" }, "In: delete"] }),
    );
    expect(read.contractForm).toBe("scope-lines");
    expect(read.interface).toEqual([]);
    expect(read.guarantees.map((g) => [g.id, g.statement, g.source, g.basis])).toEqual([
      ["S1", "put and get", { kind: "legacy", from: "scope" }, "derived"],
      ["S3", "In: delete", { kind: "legacy", from: "scope" }, "derived"],
      ["A1", "Commands wait for the lock.", { kind: "legacy", from: "assumption", id: "A1" }, "assumed-unconfirmed"],
    ]);
    for (const guarantee of read.guarantees) {
      expect([guarantee.observation, guarantee.refutedBy, guarantee.interface]).toEqual(["unclassified", [], []]);
    }
    expect(read.exclusions).toEqual([{ id: "S2", text: "replication", source: { kind: "legacy", from: "scope" } }]);
  });

  test("the direction map's assumptions read as legacy guarantees, unclassified and with nothing that could refute them", () => {
    const read = readVisionVersion(stored({ stack: "Go" }, { scopeBoundaries: [] }));
    expect(read.guarantees).toEqual([
      {
        id: "A1",
        statement: "stack: Go",
        interface: [],
        observation: "unclassified",
        refutedBy: [],
        verification: "unmarked",
        source: { kind: "legacy", from: "assumption", id: "A1" },
        basis: "assumed-unconfirmed",
      },
    ]);
  });

  test("a scope-lines row that holds contract records, or names no form, is unreadable rather than read without them", () => {
    expect(() => readVisionVersion({ ...stored([asked]), guarantees: [GUARANTEES[0]] })).toThrow(VisionUnreadable);
    expect(() => readVisionVersion({ ...stored([asked]), contractForm: null })).toThrow(VisionUnreadable);
  });
});

const TENDER = "A key-value store. Clients put and get values\nover the network. A crash never loses an acknowledged put.";
const INTERFACE = [{ id: "I1", text: "put KEY VALUE, then get KEY", source: { kind: "tender", quote: "Clients put and get values over the network." } }];
const GUARANTEES = [
  {
    id: "G1",
    statement: "A get returns the value of the last put of its key.",
    observable: { interface: ["I1"], observation: "output" },
    refutedBy: ["a get after a put returns another value"],
    source: { kind: "tender", quote: "Clients put and get values over the network." },
  },
  {
    id: "G2",
    statement: "An acknowledged put survives a crash.",
    observable: { interface: ["I1"], observation: "stored-data" },
    refutedBy: ["after the process is killed, a get misses an acknowledged put"],
    source: { kind: "assumption", id: "A1" },
  },
];
const EXCLUSIONS = [{ id: "X1", text: "No authentication.", source: { kind: "assumption", id: "A2" } }];
const DURABLE = { key: "A1", statement: "A put is acknowledged once it is on disk.", rationale: "tender", status: "Inferred", kind: "client-visible", disclosed: "asked", underpins: ["G2"] };
const OPEN = { key: "A2", statement: "Anyone on the network may connect.", rationale: "tender is silent", status: "Inferred", kind: "client-visible", disclosed: "reported", underpins: [] };
const LAYOUT = { ...internal, key: "A3" };

type Contract = { readonly interface: unknown; readonly guarantees: unknown; readonly exclusions: unknown };
const CONTRACT: Contract = { interface: INTERFACE, guarantees: GUARANTEES, exclusions: EXCLUSIONS };

const contractVersion = (inferences: unknown, contract: Contract = CONTRACT) => ({
  projectId: PROJECT,
  version: 1,
  visionText: TENDER,
  summary: "A store.",
  scopeBoundaries: [],
  inferences,
  openQuestions: [{ messageId: "q1", text: "Ack after disk?", assumptionKey: "A1" }],
  contractForm: "guarantees",
  ...contract,
});

const writeOf = (inferences: unknown, contract: Contract = CONTRACT) =>
  visionWritable(PROJECT, { visionText: TENDER, scopeBoundaries: [], inferences, openQuestions: [], contract: { form: "guarantees", ...contract } });

describe("the contract records: interface, guarantees with keys, exclusions", () => {
  test("a guarantees-form version reads its interface, guarantees and exclusions, each guarantee's basis computed", () => {
    const read = readVisionVersion(contractVersion([DURABLE, OPEN, LAYOUT]));
    expect(read.contractForm).toBe("guarantees");
    expect(read.interface).toEqual(INTERFACE);
    expect(read.guarantees.map((g) => [g.id, g.observation, g.basis])).toEqual([
      ["G1", "output", "client-stated"],
      ["G2", "stored-data", "assumed-unconfirmed"],
    ]);
    expect(read.exclusions).toEqual(EXCLUSIONS);
    expect(read.assumptions.map((a) => [a.id, a.underpins])).toEqual([["A1", ["G2"]], ["A2", []], ["A3", []]]);
  });

  test("an undecided observation is written as stored-data", () => {
    const undecided = [GUARANTEES[0], { ...GUARANTEES[1], observable: { interface: ["I1"], observation: "undecided" } }];
    const written = writeOf([DURABLE, OPEN], { ...CONTRACT, guarantees: undecided });
    expect(written.contractForm).toBe("guarantees");
    expect(written.guarantees.map((g) => g.observable.observation)).toEqual(["output", "stored-data"]);
  });

  const [first, second] = GUARANTEES;
  test.each([
    {
      case: "a quote the tender does not contain",
      inferences: [DURABLE, OPEN],
      contract: { ...CONTRACT, guarantees: [{ ...first, source: { kind: "tender", quote: "Clients put, get and delete values." } }, second] },
      refusal: /G1 quotes .* which the tender does not contain/,
    },
    {
      case: "an assumption that underpins a guarantee key the version does not hold",
      inferences: [{ ...DURABLE, underpins: ["G9"] }, OPEN],
      contract: CONTRACT,
      refusal: /assumption A1 underpins G9, which the version does not hold/,
    },
    {
      case: "an empty guarantee list",
      inferences: [LAYOUT],
      contract: { interface: INTERFACE, guarantees: [], exclusions: [] },
      refusal: /expected array to have >=1 items\s*→ at guarantees(?![[.])/,
    },
    {
      case: "a guarantee with nothing that would refute it",
      inferences: [DURABLE, OPEN],
      contract: { ...CONTRACT, guarantees: [{ ...first, refutedBy: [] }, second] },
      refusal: /expected array to have >=1 items\s*→ at guarantees\[0\]\.refutedBy/,
    },
    {
      case: "a client-visible assumption that underpins nothing and is not excluded",
      inferences: [DURABLE, OPEN],
      contract: { ...CONTRACT, exclusions: [] },
      refusal: /client-visible assumption A2 underpins no guarantee and no exclusion cites it/,
    },
  ])("$case is refused on read and on write", ({ inferences, contract, refusal }) => {
    expect(() => readVisionVersion(contractVersion(inferences, contract))).toThrow(VisionUnreadable);
    expect(() => readVisionVersion(contractVersion(inferences, contract))).toThrow(refusal);
    expect(() => writeOf(inferences, contract)).toThrow(/nothing was written/);
    expect(() => writeOf(inferences, contract)).toThrow(refusal);
  });

  test("basisOf reads assumed-unconfirmed while the cited assumption is Inferred, and client-stated once the client states it", () => {
    const g2 = { id: "G2", source: { kind: "assumption", id: "A1" } } as const;
    expect(basisOf(g2, [{ id: "A1", status: "Inferred", underpins: ["G2"] }])).toBe("assumed-unconfirmed");
    expect(basisOf(g2, [{ id: "A1", status: "Stated", underpins: ["G2"] }])).toBe("client-stated");

    const vision = Vision.read(contractVersion([DURABLE, OPEN]));
    const change = vision.stateAssumption("A1", {
      messageId: "m1",
      questionMessageId: "q1",
      question: "Ack after disk?",
      answer: "Yes.",
      verdict: "confirms",
      statement: DURABLE.statement,
      kind: null,
      rationale: "client answer",
      changeReason: "answered",
    });
    const next = readVisionVersion({ ...contractVersion(change.inferences), version: 2 });
    expect(next.guarantees.find((g) => g.id === "G2")?.basis).toBe("client-stated");
    expect(next.assumptions[0]?.underpins).toEqual(["G2"]);
  });

  test("a tender-quoted guarantee that an Inferred assumption underpins rests on that assumption", () => {
    const g1 = { id: "G1", source: { kind: "tender", quote: "Clients put and get values over the network." } } as const;
    expect(basisOf(g1, [{ id: "A1", status: "Inferred", underpins: ["G1"] }])).toBe("assumed-unconfirmed");
    expect(basisOf(g1, [])).toBe("client-stated");
  });

  test("an appended assumption names guarantees the version holds, and a client-visible one names at least one", () => {
    const vision = Vision.read(contractVersion([DURABLE, OPEN]));
    const adopt = (kind: "client-visible" | "internal-design", underpins: readonly string[]) =>
      vision.appendInferred({ statement: "s", rationale: "r", kind, disclosed: "reported", underpins, changeReason: (key) => key });
    expect(adopt("client-visible", ["G1"]).inferences.at(-1)).toMatchObject({ key: "A3", underpins: ["G1"] });
    expect(adopt("internal-design", []).key).toBe("A3");
    expect(() => adopt("client-visible", ["G7"])).toThrow(VisionChangeRefused);
    expect(() => adopt("client-visible", [])).toThrow(VisionChangeRefused);
  });
});

describe("Vision: the only way a next version is composed", () => {
  test("appendInferred takes the next free key and keeps every stored record as written", () => {
    const change = Vision.read(stored([asked, internal])).appendInferred({
      statement: "Keys are ASCII.",
      rationale: "stack",
      kind: "client-visible",
      disclosed: "reported",
      underpins: [],
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
      Vision.read(stored({ stack: "Go" })).appendInferred({ statement: "s", rationale: "r", kind: "client-visible", disclosed: "asked", underpins: [], changeReason: () => "c" }),
    ).toThrow(VisionChangeRefused);
    expect(() =>
      visionWritable(PROJECT, {
        visionText: "t",
        scopeBoundaries: [],
        inferences: { stack: "Go" },
        openQuestions: [],
        contract: { form: "scope-lines", interface: [], guarantees: [], exclusions: [] },
      }),
    ).toThrow(/nothing was written/);
  });
});

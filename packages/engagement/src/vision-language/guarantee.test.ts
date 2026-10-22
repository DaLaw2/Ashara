import { describe, expect, test } from "vitest";
import {
  ClassifiedObservationSchema,
  ContractDraftSchema,
  FirstContractSchema,
  OBSERVATION_RULE,
  StoredContractSchema,
  declinesUnverifiable,
  markOf,
  markWords,
  visionGuaranteeOf,
} from "./guarantee.js";

const quote = { kind: "tender", quote: "A ledger." } as const;

function contractObserved(observation: string, marks: Record<string, string> = {}) {
  return {
    interface: [{ id: "I1", text: "ledger list", source: quote }],
    guarantees: [{ id: "G1", statement: "Entries are kept.", observable: { interface: ["I1"], observation }, refutedBy: ["an entry is missing"], source: quote, ...marks }],
    exclusions: [],
  };
}

// Drafter outputs for guarantees a black-box check through the product's interface shows, each
// classified as OBSERVATION_RULE asks: a command's output, an HTTP response, or what reading back
// through the interface shows after earlier uses, an environment setting or a restart.
const INTERFACE_OBSERVED = [
  { statement: "Every note keeps the id it was given when it was added.", refutedBy: ["listing notes after further adds shows a note under another id"] },
  { statement: "Finishing a note marks it finished.", refutedBy: ["the note listed after `finish <id>` is not marked finished"] },
  { statement: "A missing notes file reads as no notes.", refutedBy: ["`list` with no notes file exits non-zero or prints a note"] },
  { statement: "Adding a note whose title is taken gives the new note its own id.", refutedBy: ["the second note added with a taken title shows the first note's id"] },
  { statement: "When LIBRARY_NOW is set, it is the clock for due dates.", refutedBy: ["with LIBRARY_NOW set, a created loan's due date is not based on that instant"] },
  { statement: "Members, items, loans and reservations survive a server restart.", refutedBy: ["a member created before a restart is missing from GET /members after it"] },
  { statement: "POST /loans creates an open loan due exactly 7 days after creation.", refutedBy: ["POST /loans returns a loan whose due date is not 7 days after creation"] },
  { statement: "Returning a loan with a condition note ends the loan and updates the item's condition note.", refutedBy: ["GET /items/{id} after the return shows the old condition note"] },
].map((g, i) => ({ id: `G${i + 1}`, ...g, observable: { interface: ["I1"], observation: "output" }, source: quote }));

const RECORDED_DRAFT = JSON.stringify({ interface: [{ id: "I1", text: "the product's commands and routes", source: quote }], guarantees: INTERFACE_OBSERVED, exclusions: [] });

describe("a drafter's observation classification", () => {
  test("keeps undecided as the drafter gave it, never read as stored-data", () => {
    expect(ClassifiedObservationSchema.parse("undecided")).toBe("undecided");
    expect(ClassifiedObservationSchema.parse("output")).toBe("output");
    expect(ClassifiedObservationSchema.safeParse("unknown").success).toBe(false);
  });

  test("an undecided guarantee is stored undecided and marked undecided: never stored-data, never not verifiable", () => {
    expect(markOf("undecided")).toEqual({ verification: "undecided" });
    const [undecided] = FirstContractSchema.parse(contractObserved("undecided")).guarantees;
    expect(undecided).toMatchObject({ observable: { observation: "undecided" }, verification: "undecided" });
    expect(undecided).not.toHaveProperty("unverifiableBecause");
    const read = visionGuaranteeOf(StoredContractSchema.parse(FirstContractSchema.parse(contractObserved("undecided"))).guarantees[0], []);
    expect(read).toMatchObject({ observation: "unclassified", verification: "undecided" });
    expect(markWords(markOf("undecided"))).toContain("Ashara could not tell where you would see it hold or break");
  });

  test("a guarantee is marked not verifiable only with its stated reason", () => {
    expect(markOf("stored-data")).toEqual({ verification: "not-by-ashara", unverifiableBecause: "outside-interface" });
    expect(FirstContractSchema.parse(contractObserved("stored-data")).guarantees[0]).toMatchObject({ verification: "not-by-ashara", unverifiableBecause: "outside-interface" });
    expect(markWords(markOf("stored-data"))).toMatch(/^not verifiable by Ashara: it is seen only outside what the product's interface shows/);
    for (const observation of ["output", "errors", "exit-status"] as const) expect(markOf(observation)).toEqual({ verification: "by-ashara" });
    // A stored mark not-by-ashara needs its reason, except on a stored-data guarantee marked before the reason was recorded.
    expect(StoredContractSchema.safeParse(contractObserved("output", { verification: "not-by-ashara" })).success).toBe(false);
    expect(StoredContractSchema.parse(contractObserved("stored-data", { verification: "not-by-ashara" })).guarantees[0]).toMatchObject({ unverifiableBecause: "outside-interface" });
    expect(StoredContractSchema.safeParse(contractObserved("undecided", { verification: "not-by-ashara", unverifiableBecause: "outside-interface" })).success).toBe(false);
    expect(StoredContractSchema.safeParse(contractObserved("output", { verification: "by-ashara", unverifiableBecause: "outside-interface" })).success).toBe(false);
    expect(StoredContractSchema.safeParse(contractObserved("output", { verification: "undecided" })).success).toBe(false);
  });

  test("guarantees a check shows through the interface, drafted as the rule asks, are all ones Ashara can verify", () => {
    const draft = ContractDraftSchema.parse(JSON.parse(RECORDED_DRAFT));
    const first = FirstContractSchema.parse(draft);
    expect(first.guarantees.map((g) => g.verification)).toEqual(INTERFACE_OBSERVED.map(() => "by-ashara"));
    expect(declinesUnverifiable(first.guarantees.map((g) => visionGuaranteeOf(g, [])))).toBe(false);
  });

  test("the rule tells the drafter that what reading back through the interface shows, after a restart or an environment setting, is not stored-data", () => {
    const rule = OBSERVATION_RULE.join("\n");
    expect(rule).toContain("stopping the\n  product and starting it again, then reading what comes back through the interface");
    expect(rule).toContain("setting the environment and configuration the product is given");
    expect(rule).toContain(`"stored-data" only when nothing read through the interface shows it`);
    expect(rule).toContain(`survives a restart is not\n    "stored-data" when reading it back through the interface shows it`);
  });
});

describe("a contract Ashara can verify no guarantee of", () => {
  test("is declined whether its guarantees are marked not verifiable, undecided or both", () => {
    const read = (observations: readonly string[]) =>
      observations.map((observation) => visionGuaranteeOf(FirstContractSchema.parse(contractObserved(observation)).guarantees[0], []));
    expect(declinesUnverifiable(read(["stored-data"]))).toBe(true);
    expect(declinesUnverifiable(read(["undecided"]))).toBe(true);
    expect(declinesUnverifiable(read(["undecided", "stored-data"]))).toBe(true);
    expect(declinesUnverifiable(read(["undecided", "output"]))).toBe(false);
  });
});

describe("a guarantee stored before the contract carried the verification mark", () => {
  test("stays unmarked when a later version carries it over, so the contract in force is never declined by it", () => {
    const stored = StoredContractSchema.parse(contractObserved("stored-data"));
    const read = (contract: typeof stored) => contract.guarantees.map((g) => visionGuaranteeOf(g, []));
    expect(read(stored).map((g) => g.verification)).toEqual(["unmarked"]);
    const carried = StoredContractSchema.parse(stored);
    expect(carried.guarantees[0]).not.toHaveProperty("verification");
    expect(read(carried).map((g) => g.verification)).toEqual(["unmarked"]);
    expect(declinesUnverifiable(read(carried))).toBe(false);
  });

  test("a later version keeps the mark a guarantee was stored with, and refuses an undecided one no writer marked", () => {
    const marked = FirstContractSchema.parse(contractObserved("stored-data"));
    expect(StoredContractSchema.parse(marked).guarantees[0]).toMatchObject({ verification: "not-by-ashara", unverifiableBecause: "outside-interface" });
    expect(StoredContractSchema.safeParse(contractObserved("undecided")).success).toBe(false);
  });
});

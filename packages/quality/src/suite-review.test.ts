import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PreCallRefusal, SecondOpinionUnanswered, SecondOpinionUnavailable } from "@ashara/finance";
import type { ContextualLlm, SecondOpinionStrength } from "@ashara/finance";
import { StructuredOutputExhausted } from "@ashara/finance";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { VisionSource } from "./acl/engagement-acl.js";
import { SuiteReviewer, gitPublicInterface } from "./suite-review.js";
import type { SuiteReviewSource } from "./suite-review.js";
import type { TaskChecks } from "./task-checks.js";

type PublicInterfaceReader = ConstructorParameters<typeof SuiteReviewer>[0]["publicInterface"];

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000cc", "test");
const REVIEW_ID = createWorkItemId();
const IMPL_A = createWorkItemId();
const IMPL_B = createWorkItemId();
const CHECK_A = "check-a";
const CHECK_B = "check-b";
const SCOPE: VisionSource = { type: "scope", id: "S1", text: "In: monthly totals of a CSV of expenses", side: "in" };
const REFUSAL: VisionSource = {
  type: "assumption",
  id: "A3",
  text: "Malformed rows are refused with their line number",
  status: "Inferred",
  standing: "reported",
  kind: "client-visible",
};
const LEDGER: VisionSource = {
  type: "assumption",
  id: "A4",
  text: "Totals are cached in totals.db",
  status: "Inferred",
  standing: "reported",
  kind: "internal-design",
};
const SOURCES = [SCOPE, REFUSAL, LEDGER];
const VISION = SOURCES.map((item) => item.text);
const BASELINE = "b".repeat(40);
const PROJECT_PATH = "/srv/projects/expenses";
const INTERFACE_TEXT = "Run: totals <file.csv>\nExit 3: a malformed row, with its line number on stderr.";

/** One check, deciding the item its check task cites. */
function stored(checkTaskId: string, name: string, command: string): TaskChecks {
  const decides: [string] = [checkTaskId === CHECK_B ? REFUSAL.id : SCOPE.id];
  return { checkTaskId, revision: 1, environmentVersion: "v1", baselineCommit: BASELINE, checks: [{ name, command, decides }], files: [{ path: "checks/t.sh", content: "exit 1" }] };
}

/** PUBLIC_INTERFACE.md at the baseline only; every read is recorded. */
function interfaceAt(reads: Array<{ path: string; commit: string }> = []): PublicInterfaceReader {
  return {
    at: async (path, commit) => {
      reads.push({ path, commit });
      return commit === BASELINE ? { kind: "present", text: INTERFACE_TEXT } : { kind: "absent" };
    },
  };
}
const INTERFACE = interfaceAt();

function source(statusB = "Completed", options: { readonly frozen?: boolean; readonly reopensA?: number } = {}): SuiteReviewSource {
  return {
    checkTasksUnderReview: async () => [
      { id: CHECK_A, status: "Completed", checksFor: IMPL_A, visionItems: [SCOPE.text], sources: [SCOPE], checkedTitle: "Sum by month", reviewReopens: options.reopensA ?? 0 },
      { id: CHECK_B, status: statusB, checksFor: IMPL_B, visionItems: [REFUSAL.text], sources: [REFUSAL], checkedTitle: "Refuse bad rows", reviewReopens: 0 },
    ],
    latest: async (taskId) => (taskId === IMPL_A ? stored(CHECK_A, "prints-count", "sh checks/count.sh") : stored(CHECK_B, "stdout-empty", "sh checks/empty.sh")),
    frozen: async () => options.frozen ?? false,
  };
}

/** Another model family than the stub's: a second review from it can confirm a finding no witness settles. */
const OTHER_FAMILY = { provider: "other", model: "other-strong" };
/** Another model of the stub's own family. */
const SIBLING = { provider: "stub", model: "stub-sibling" };

/** The model the stub's catalog serves each strength of second opinion with; a strength it lacks is unavailable. */
type StubCatalog = Partial<Record<SecondOpinionStrength, { readonly provider: string; readonly model: string }>>;
/** A deployment with one model at all: only the same model can answer a second time. */
const ONE_MODEL: StubCatalog = { "same-model": { provider: "stub", model: "stub-model" } };
/** A deployment with a model of another family: it answers. */
const TWO_FAMILIES: StubCatalog = { "other-family": OTHER_FAMILY };
/** A deployment with one provider key and two models: another model of the same family answers. */
const ONE_FAMILY: StubCatalog = { "same-family-other-model": SIBLING };

/** The bound a review asks with, read off the requests a one-model catalog answers. */
function bounds(into: number[]): ContextualLlm {
  return {
    forCall: () => ({
      generateStructured: async (request) => {
        const opinion = request.secondOpinion;
        if (opinion !== undefined && opinion.strength !== "same-model") throw new SecondOpinionUnavailable(opinion, request.capability, []);
        into.push(request.maxTokens);
        return { data: request.schema.parse({ problems: [] }), provider: "stub", model: "stub-model" };
      },
    }),
  };
}

/**
 * Answers every structured call with the next scripted answer, parsed by the request's own schema.
 * A request for a second opinion is answered by the model `catalog` serves its strength with, as the
 * gateway would; a strength the catalog lacks is refused unsent, consuming no answer.
 */
function scripted(answers: readonly unknown[], prompts: string[] = [], catalog: StubCatalog = ONE_MODEL, asked: unknown[] = []): ContextualLlm {
  let next = 0;
  return {
    forCall: () => ({
      generateStructured: async (request) => {
        const opinion = request.secondOpinion;
        asked.push(opinion?.strength);
        let by: { readonly provider: string; readonly model: string } = { provider: "stub", model: "stub-model" };
        if (opinion !== undefined) {
          const served = catalog[opinion.strength];
          if (served === undefined) throw new SecondOpinionUnavailable(opinion, request.capability, []);
          by = served;
        }
        prompts.push(request.prompt);
        const answer = answers[Math.min(next, answers.length - 1)];
        next++;
        if (answer instanceof Error) throw answer;
        return { data: request.schema.parse(answer), ...by };
      },
    }),
  };
}

type Judgements = ConstructorParameters<typeof SuiteReviewer>[0]["judgements"];
type Recorded = Parameters<Judgements["record"]>[0];

/** Keeps every recorded review's judgements in `into`. */
function keep(into: Recorded[] = []): Judgements {
  return {
    record: async (review) => {
      into.push(review);
    },
  };
}

const TASK = { id: REVIEW_ID, projectId: PROJECT, taskSpec: { origin: "review" as const, visionItems: VISION, sources: SOURCES } };

const STUB = { provider: "stub", model: "stub-model" };
const ITEM_A = { checkTaskId: CHECK_A, itemId: SCOPE.id, itemText: SCOPE.text };
const ITEM_B = { checkTaskId: CHECK_B, itemId: REFUSAL.id, itemText: REFUSAL.text };
/** The claim of a clean review another model family confirmed: every covered item reads as verified. */
const CONFIRMED = {
  basis: "second-opinion-clean",
  strength: "other-family",
  why: "a second review found no problem in them either; the second review was a review by another model family, other/other-strong, than the first's stub/stub-model",
  unconfirmed: [],
};
/** The claim of a clean review the same model, asked again from another angle, confirmed: the only second opinion a one-model deployment has. */
const RESAMPLED = {
  basis: "second-opinion-clean",
  strength: "same-model",
  why: "a second review found no problem in them either; the second review was the first review's model stub/stub-model asked again from another angle, which shares every blind spot of the first",
  unconfirmed: [],
};

describe("SuiteReviewer (ADR-074 addendum 2 d71 c)", () => {
  test("a clean verdict is accepted after its schema validates; the prompt holds every suite and the vision", async () => {
    const prompts: string[] = [];
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }], prompts, TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep() });

    expect(await reviewer.review(TASK, PROJECT_PATH)).toEqual({ kind: "clean", reviewed: [CHECK_A, CHECK_B], setAside: [], released: [], advisory: [], undecided: [], claim: CONFIRMED });
    expect(prompts).toHaveLength(2);
    for (const text of [...VISION, `## Check task ${CHECK_A}`, `## Check task ${CHECK_B}`, "sh checks/count.sh", "sh checks/empty.sh", "--- file checks/t.sh"]) {
      expect(prompts[0]).toContain(text);
    }
  });

  // An empty problem list is a claim about the checks, as a finding
  // is; the items it covers read as verified only when an independent second review is clean too.
  describe("a review that finds nothing is a claim", () => {
    test("it is confirmed by a second review asked of another model family first, recorded whole with its strength", async () => {
      const asked: unknown[] = [];
      const recorded: Recorded[] = [];
      const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }], [], TWO_FAMILIES, asked), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });
      expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean", claim: CONFIRMED });
      expect(asked).toEqual([undefined, "other-family"]);
      expect(recorded).toEqual([
        {
          projectId: PROJECT,
          reviewTaskId: REVIEW_ID,
          judgements: [],
          claim: {
            basis: "second-opinion-clean",
            covered: [CHECK_A, CHECK_B],
            firstModel: STUB,
            secondReview: { strength: "other-family", first: STUB, second: OTHER_FAMILY },
            passedOver: [],
            second: [],
            secondFailure: null,
            unconfirmed: [],
          },
        },
      ]);
    });

    test("a second review that finds something reopens nothing and leaves the items it names unverified", async () => {
      const recorded: Recorded[] = [];
      const doubt = { checkTasks: [CHECK_B], kind: "undecided-item", item: REFUSAL.id, problem: "stdout-empty never feeds a malformed row", evidence: "sh checks/empty.sh" };
      const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }, { problems: [doubt] }], [], TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });
      expect(await reviewer.review(TASK, PROJECT_PATH)).toEqual({
        kind: "clean",
        reviewed: [CHECK_A, CHECK_B],
        setAside: [],
        released: [],
        advisory: [],
        undecided: [],
        claim: {
          basis: "second-opinion-found",
          strength: "other-family",
          why:
            "the review that found no problem in them was not confirmed: a second review found one; the second review was a review by another model family, " +
            "other/other-strong, than the first's stub/stub-model",
          unconfirmed: [ITEM_B],
        },
      });
      expect(recorded[0]).toMatchObject({ judgements: [], claim: { basis: "second-opinion-found", second: [doubt], unconfirmed: [ITEM_B] } });
    });

    test("a contradiction the second review finds leaves every item of both its check tasks unverified", async () => {
      const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }, { problems: [conflict] }], [], TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep() });
      expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean", claim: { basis: "second-opinion-found", unconfirmed: [ITEM_A, ITEM_B] } });
    });

    test("a second review that fails at every strength leaves every covered item unverified with why, and the plan still proceeds", async () => {
      const recorded: Recorded[] = [];
      const failed = new SecondOpinionUnanswered({ avoid: STUB, strength: "other-family" }, OTHER_FAMILY, { cause: new Error("503 overloaded") });
      const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }, failed], [], TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });
      const outcome = await reviewer.review(TASK, PROJECT_PATH);
      expect(outcome).toMatchObject({ kind: "clean", claim: { basis: "second-review-failed", strength: null, unconfirmed: [ITEM_A, ITEM_B] } });
      if (outcome.kind !== "clean") return expect.unreachable("an unconfirmed claim routes nothing");
      expect(outcome.claim.why).toContain("the review that found no problem in them was not confirmed: the second review failed at every strength the catalog offers (other-family failed: SecondOpinionUnanswered: ");
      expect(recorded[0]?.claim).toMatchObject({
        basis: "second-review-failed",
        secondReview: null,
        second: [],
        secondFailure: expect.stringContaining("503 overloaded"),
        passedOver: [
          { strength: "other-family", outcome: "failed", reason: expect.stringContaining("503 overloaded") },
          { strength: "same-family-other-model", outcome: "unavailable", reason: expect.stringContaining("SecondOpinionUnavailable") },
          { strength: "same-model", outcome: "unavailable", reason: expect.stringContaining("SecondOpinionUnavailable") },
        ],
      });
    });

    test("an item no check of its suite records it decides is not claimed: it is reported as decided by none", async () => {
      const undecidedB: SuiteReviewSource = {
        ...source(),
        latest: async (taskId) => (taskId === IMPL_A ? stored(CHECK_A, "prints-count", "sh checks/count.sh") : { ...stored(CHECK_B, "stdout-empty", "sh checks/empty.sh"), checks: [{ name: "stdout-empty", command: "sh checks/empty.sh", decides: null }] }),
      };
      const doubt = { checkTasks: [CHECK_A], kind: "undecided-item", item: SCOPE.id, problem: "prints-count never reads a month's total", evidence: "sh checks/count.sh" };
      const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }, { problems: [doubt] }]), source: undecidedB, publicInterface: INTERFACE, judgements: keep() });
      expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean", claim: { basis: "second-opinion-found", unconfirmed: [ITEM_A] } });
    });

    test("after the check set freezes, a clean review is still confirmed or not, and nothing reopens on the second's findings", async () => {
      const doubt = { checkTasks: [CHECK_A], kind: "undecided-item", item: SCOPE.id, problem: "prints-count never reads a month's total", evidence: "sh checks/count.sh" };
      const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }, { problems: [doubt] }], [], TWO_FAMILIES), source: source("Completed", { frozen: true }), publicInterface: INTERFACE, judgements: keep() });
      expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean", claim: { basis: "second-opinion-found", unconfirmed: [ITEM_A] } });
    });

    test("an item a finding already left undecided is not claimed again, and a review that routes something claims nothing", async () => {
      const recorded: Recorded[] = [];
      const doubt = { checkTasks: [CHECK_A], kind: "undecided-item", item: SCOPE.id, problem: "prints-count never reads a month's total", evidence: "sh checks/count.sh" };
      const advisoryOnly = new SuiteReviewer({ llm: scripted([{ problems: [doubt] }, { problems: [] }], [], TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });
      expect(await advisoryOnly.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean", undecided: [ITEM_A], claim: CONFIRMED });
      expect(recorded[0]?.claim).toMatchObject({ basis: "second-opinion-clean", unconfirmed: [] });
      const routing = new SuiteReviewer({ llm: scripted([{ problems: [doubt] }, { problems: [doubt] }], [], TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });
      expect(await routing.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "problems" });
      expect(recorded[1]?.claim).toBeNull();
    });
  });

  // The second opinion goes to another family, else another model of
  // the family, else (in a one-model deployment) the same model; the last two from another angle.
  describe("the second opinion's strength", () => {
    test("a deployment with one provider key and two models confirms with the other model, asked to look for what the checks cannot observe", async () => {
      const asked: unknown[] = [];
      const prompts: string[] = [];
      const recorded: Recorded[] = [];
      const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }], prompts, ONE_FAMILY, asked), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });
      expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean", claim: { basis: "second-opinion-clean", strength: "same-family-other-model", unconfirmed: [] } });
      expect(asked).toEqual([undefined, "other-family", "same-family-other-model"]);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).not.toContain("work out what it cannot observe");
      expect(prompts[1]).toContain("For each check, work out what it cannot observe");
      // The same inputs, and none of the first's verdict.
      expect(prompts[1]).toContain(prompts[0]?.split("# What to return")[0] ?? "unreachable");
      expect(recorded[0]?.claim).toMatchObject({
        secondReview: { strength: "same-family-other-model", first: STUB, second: SIBLING },
        passedOver: [{ strength: "other-family", outcome: "unavailable", reason: expect.stringContaining("no model serves a other-family second opinion") }],
      });
    });

    test("a deployment with one model at all confirms with the same model, asked from the other angle, and says so", async () => {
      const asked: unknown[] = [];
      const prompts: string[] = [];
      const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }], prompts, ONE_MODEL, asked), source: source(), publicInterface: INTERFACE, judgements: keep() });
      expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean", claim: RESAMPLED });
      expect(asked).toEqual([undefined, "other-family", "same-family-other-model", "same-model"]);
      expect(prompts[1]).toContain("For each check, work out what it cannot observe");
    });

    test("another family that never answers within contract is passed over, recorded, for another model of the first's family", async () => {
      const recorded: Recorded[] = [];
      const ghost = { problems: [{ ...conflict, checkTasks: ["ghost"] }] };
      const reviewer = new SuiteReviewer({
        // Two attempts at the base tier and two at the escalated one, all unfit.
        llm: scripted([{ problems: [] }, ghost, ghost, ghost, ghost, { problems: [] }], [], { "other-family": OTHER_FAMILY, "same-family-other-model": SIBLING }),
        source: source(),
        publicInterface: INTERFACE,
        judgements: keep(recorded),
      });
      expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean", claim: { basis: "second-opinion-clean", strength: "same-family-other-model" } });
      expect(recorded[0]?.claim?.passedOver).toEqual([{ strength: "other-family", outcome: "failed", reason: expect.stringContaining("StructuredOutputExhausted") }]);
    });

    test("an answer from a model of another strength than the one asked is never read as agreement", async () => {
      const lying: ContextualLlm = {
        forCall: () => ({
          generateStructured: async (request) => ({ data: request.schema.parse({ problems: [] }), ...STUB }),
        }),
      };
      const reviewer = new SuiteReviewer({ llm: lying, source: source(), publicInterface: INTERFACE, judgements: keep() });
      await expect(reviewer.review(TASK, PROJECT_PATH)).rejects.toMatchObject({ name: "SecondOpinionMisrouted" });
    });

    test("a finding the same family's other model agrees on acts, and the routed text names how independent that review was", async () => {
      const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [conflict] }, { problems: [conflict] }], [], ONE_FAMILY), source: source(), publicInterface: INTERFACE, judgements: keep() });
      const outcome = await reviewer.review(TASK, PROJECT_PATH);
      if (outcome.kind !== "problems") return expect.unreachable("an agreed contradiction is routed");
      expect(outcome.problems[0]?.problem).toContain(
        "Two reviews, the first by stub/stub-model and the second a review by another model of the same family, which shares more blind spots with the first than another family would, stub/stub-sibling, than the first's stub/stub-model, each found",
      );
    });
  });

  // A contradiction quotes what each of its two checks requires; Z0 holds each
  // quote to its check, and an independent second review must reach the same pair before anything reopens.
  const conflict = {
    checkTasks: [CHECK_A, CHECK_B],
    kind: "contradiction",
    conflict: {
      first: { checkTask: CHECK_A, check: "prints-count", requires: "sh checks/count.sh" },
      second: { checkTask: CHECK_B, check: "stdout-empty", requires: "sh   checks/empty.sh" },
    },
    problem: "a prints a count, b requires empty stdout",
    evidence: "count.sh; empty.sh",
  };

  test("a grounded contradiction another model family reaches too is routed to both check tasks with its quotes", async () => {
    const recorded: Recorded[] = [];
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [conflict] }, { problems: [conflict] }], [], TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });

    const outcome = await reviewer.review(TASK, PROJECT_PATH);
    expect(outcome).toMatchObject({ kind: "problems", advisory: [], undecided: [], problems: [{ checkTaskIds: [CHECK_A, CHECK_B], kind: "contradiction", evidence: conflict.evidence }] });
    if (outcome.kind !== "problems") return expect.unreachable("an agreed contradiction is routed");
    expect(outcome.problems[0]?.problem).toContain("Two reviews, the first by stub/stub-model and the second a review by another model family, other/other-strong, than the first's stub/stub-model,");
    expect(outcome.problems[0]?.problem).toContain(`check "stdout-empty" of ${CHECK_B} requires "sh   checks/empty.sh"`);
    expect(recorded[0]?.judgements).toMatchObject([{ checkTaskId: CHECK_A, check: null, outcome: "routed", basis: "second-opinion-agreed" }]);
  });

  test("a self-refuting contradiction the other family's review does not reach is kept as advisory and routes nothing", async () => {
    const recorded: Recorded[] = [];
    const refuted = { ...conflict, problem: "a product satisfying both still passes them; the real conflict is elsewhere" };
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [refuted] }, { problems: [] }], [], TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });

    expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({
      kind: "clean",
      advisory: [
        {
          checkTaskIds: [CHECK_A, CHECK_B],
          kind: "contradiction",
          why: "the second review did not reach it; the second review was a review by another model family, other/other-strong, than the first's stub/stub-model",
        },
      ],
      undecided: [],
    });
    expect(recorded[0]?.judgements).toMatchObject([{ outcome: "advisory", basis: "second-opinion-disagreed", second: [] }]);
  });

  test("in a one-model deployment a contradiction the same model reaches again from the other angle is routed, named as the same model", async () => {
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [conflict] }, { problems: [conflict] }]), source: source(), publicInterface: INTERFACE, judgements: keep() });
    const outcome = await reviewer.review(TASK, PROJECT_PATH);
    if (outcome.kind !== "problems") return expect.unreachable("an agreed contradiction is routed");
    expect(outcome.problems[0]?.problem).toContain("the second the first review's model stub/stub-model asked again from another angle, which shares every blind spot of the first");
  });

  test("a contradiction quoting text its check does not hold, or one check twice, is re-asked", async () => {
    const prompts: string[] = [];
    const { first: sideA, second: sideB } = conflict.conflict;
    const misquoted = { ...conflict, conflict: { first: sideA, second: { ...sideB, requires: "stdout is never empty" } } };
    const twice = { ...conflict, checkTasks: [CHECK_A], conflict: { first: sideA, second: sideA } };
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [misquoted, twice] }, { problems: [] }], prompts), source: source(), publicInterface: INTERFACE, judgements: keep() });
    expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean", advisory: [] });
    expect(prompts[1]).toContain(`quotes "stdout is never empty" as what check "stdout-empty" requires, but neither its command nor any file of check task ${CHECK_B} holds that text`);
    expect(prompts[1]).toContain(`gives one check, "prints-count" of ${CHECK_A}, as both sides of its conflict`);
  });

  // A check's stored decides is its author's claim; the reviewer judges whether any check really decides the item.
  const undecided = { checkTasks: [CHECK_A], kind: "undecided-item", item: SCOPE.id, problem: "prints-count never reads a month's total", evidence: "sh checks/count.sh" };

  test("an undecided item another model family agrees on is routed to its check task; one its task does not cite is re-asked", async () => {
    const prompts: string[] = [];
    const uncited = { ...undecided, item: REFUSAL.id };
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [uncited] }, { problems: [undecided] }, { problems: [undecided] }], prompts, TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep() });

    const outcome = await reviewer.review(TASK, PROJECT_PATH);
    expect(outcome).toMatchObject({ kind: "problems", undecided: [], problems: [{ checkTaskIds: [CHECK_A], kind: "undecided-item", evidence: undecided.evidence }] });
    if (outcome.kind !== "problems") return expect.unreachable("an agreed undecided item is routed");
    expect(outcome.problems[0]?.problem).toBe(
      `Cited item ${SCOPE.id} is decided by none of the checks: ${undecided.problem} Two reviews, the first by stub/stub-model and the second a review by ` +
        `another model family, other/other-strong, than the first's stub/stub-model, each found it so.`,
    );
    expect(prompts[0]).toContain(`- "prints-count" (its author says it decides S1): sh checks/count.sh`);
    expect(prompts[0]).toContain(`"undecided-item": an item a check task's own task cites that none of its checks decides`);
    expect(prompts[1]).toContain(`names item ${JSON.stringify(REFUSAL.id)} as decided by no check, but check task ${CHECK_A} does not cite it`);
  });

  test("an undecided item the second review does not reach reopens nothing: it is kept advisory, recorded whole, and the item stays undecided", async () => {
    const recorded: Recorded[] = [];
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [undecided] }, { problems: [] }], [], ONE_FAMILY), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });

    const item = { checkTaskId: CHECK_A, itemId: SCOPE.id, itemText: SCOPE.text };
    expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({
      kind: "clean",
      undecided: [item],
      advisory: [{ kind: "undecided-item", why: expect.stringContaining("the second review did not reach it; the second review was a review by another model of the same family") }],
    });
    expect(recorded[0]?.judgements).toEqual([
      {
        checkTaskId: CHECK_A,
        check: null,
        outcome: "advisory",
        basis: "second-opinion-disagreed",
        first: undecided,
        firstModel: STUB,
        second: [],
        secondReview: { strength: "same-family-other-model", first: STUB, second: SIBLING },
        passedOver: [{ strength: "other-family", outcome: "unavailable", reason: expect.stringContaining("SecondOpinionUnavailable") }],
        secondFailure: null,
        undecided: item,
      },
    ]);
  });

  // A second review that failed is recorded and reported as failed, never as a disagreement.
  test("a second review no model answered leaves every finding advisory, recorded as failed with why, and the item undecided", async () => {
    const recorded: Recorded[] = [];
    const failed = new SecondOpinionUnanswered({ avoid: STUB, strength: "other-family" }, OTHER_FAMILY, { cause: new Error("400 Invalid schema") });
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [undecided, conflict] }, failed], [], TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });

    const outcome = await reviewer.review(TASK, PROJECT_PATH);
    expect(outcome).toMatchObject({ kind: "clean", undecided: [{ checkTaskId: CHECK_A, itemId: SCOPE.id }] });
    expect(outcome.advisory.map((each) => each.why)).toEqual([
      expect.stringContaining("the second review that could have confirmed or settled it failed at every strength, so nothing confirmed it (other-family failed: SecondOpinionUnanswered: "),
      expect.stringContaining("the second review that could have confirmed or settled it failed"),
    ]);
    expect(recorded[0]?.judgements).toMatchObject([
      { outcome: "advisory", basis: "second-review-failed", second: [], secondReview: null, secondFailure: expect.stringContaining("400 Invalid schema") },
      { outcome: "advisory", basis: "second-review-failed", second: [], secondReview: null, secondFailure: expect.stringContaining("400 Invalid schema") },
    ]);
  });

  test("a second review whose answers never validate is a failed review, never a disagreement", async () => {
    const recorded: Recorded[] = [];
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [undecided] }, { problems: [{ ...undecided, checkTasks: ["ghost"] }] }], [], TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });
    expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean", undecided: [{ itemId: SCOPE.id }] });
    expect(recorded[0]?.judgements).toMatchObject([{ basis: "second-review-failed", secondFailure: expect.stringContaining("StructuredOutputExhausted") }]);
  });

  test("a refusal that is not the second review's own failure fails the review instead of reading as one", async () => {
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [undecided] }, new PreCallRefusal("budget_cap: refused")], [], TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep() });
    await expect(reviewer.review(TASK, PROJECT_PATH)).rejects.toBeInstanceOf(PreCallRefusal);
  });

  test("an undecided item the other family does not reach stays undecided", async () => {
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [undecided] }, { problems: [] }], [], TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep() });
    expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean", undecided: [{ itemId: SCOPE.id }], advisory: [{ why: expect.stringContaining("the second review did not reach it") }] });
  });

  // The rounds of a revision's review are bounded by its durable record, and a frozen check set reopens nothing.
  test("an undecided item on a check task the review already reopened once is kept undecided whatever the second review says", async () => {
    const prompts: string[] = [];
    const recorded: Recorded[] = [];
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [undecided] }], prompts, TWO_FAMILIES), source: source("Completed", { reopensA: 1 }), publicInterface: INTERFACE, judgements: keep(recorded) });
    expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean", undecided: [{ itemId: SCOPE.id }], advisory: [{ why: "its check task was already reopened once by this review" }] });
    expect(prompts).toHaveLength(2);
    expect(recorded[0]?.judgements).toMatchObject([{ outcome: "advisory", basis: "reopened-once", second: [undecided] }]);
  });

  test("after the check set freezes, a new finding of any kind reopens nothing and its item is reported undecided", async () => {
    const prompts: string[] = [];
    const recorded: Recorded[] = [];
    const findings = { problems: [undecided, conflict, rowCount] };
    const reviewer = new SuiteReviewer({ llm: scripted([findings, findings], prompts, TWO_FAMILIES), source: source("Completed", { frozen: true }), publicInterface: INTERFACE, judgements: keep(recorded) });
    expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean", released: [], undecided: [{ itemId: SCOPE.id }] });
    expect(prompts).toHaveLength(2);
    expect(recorded[0]?.judgements.map((judgement) => [judgement.first.kind, judgement.outcome, judgement.basis])).toEqual([
      ["undecided-item", "advisory", "frozen"],
      ["contradiction", "advisory", "frozen"],
      ["outside-vision", "advisory", "frozen"],
    ]);
  });

  test("the review's output bound holds a full findings answer: never the 4,096 tokens a findings answer runs past, and more with more checks", async () => {
    const asked: number[] = [];
    await new SuiteReviewer({ llm: bounds(asked), source: source(), publicInterface: INTERFACE, judgements: keep() }).review(TASK, PROJECT_PATH);
    const many: SuiteReviewSource = {
      ...source(),
      latest: async (taskId) => ({ ...stored(taskId === IMPL_A ? CHECK_A : CHECK_B, "c", "sh c.sh"), checks: Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, command: "sh c.sh", decides: ["S1"] })) }),
    };
    await new SuiteReviewer({ llm: bounds(asked), source: many, publicInterface: INTERFACE, judgements: keep() }).review(TASK, PROJECT_PATH);
    // Each review asks twice, the second review with the first's bound.
    expect(asked[0]).toBeGreaterThan(4096);
    expect(asked[1]).toBe(asked[0]);
    expect(asked[2]).toBeGreaterThan(asked[0] ?? Infinity);
  });

  test("a verdict naming a check task it did not read is re-asked, and one that never validates gives no verdict", async () => {
    const prompts: string[] = [];
    const ghost = { problems: [{ ...conflict, checkTasks: ["ghost"] }] };
    const reviewer = new SuiteReviewer({ llm: scripted([ghost], prompts), source: source(), publicInterface: INTERFACE, judgements: keep() });

    await expect(reviewer.review(TASK, PROJECT_PATH)).rejects.toBeInstanceOf(StructuredOutputExhausted);
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[1]).toContain('names check task "ghost"');
  });

  // A check file's path carries the id of the task whose checks it holds, which is not a check task id.
  test("the prompt says which id names a suite, and a finding naming the checked task's id is re-asked naming the check task", async () => {
    const prompts: string[] = [];
    const byImplId = { ...undecided, checkTasks: [IMPL_A] };
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [byImplId] }, { problems: [] }], prompts), source: source(), publicInterface: INTERFACE, judgements: keep() });
    expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean" });
    expect(prompts[0]).toContain(`(task ${IMPL_A}, whose id the paths of the files below may carry; it is not a check task id: a finding on these checks names check task ${CHECK_A})`);
    expect(prompts[1]).toContain(`names check task ${JSON.stringify(IMPL_A)}, which is none of [${CHECK_A}, ${CHECK_B}]: ${IMPL_A} is the task whose checks check task ${CHECK_A} wrote, so name check task ${CHECK_A}`);
  });

  test("a quote no stored text holds is re-asked with its first missing line and the stored line nearest it", async () => {
    const prompts: string[] = [];
    const file = 'before=$(dsize "$D")\nafter=$(dsize "$D")\n[ $((after * 2)) -lt "$before" ] || fail "store did not shrink"\n';
    const withFile: SuiteReviewSource = {
      ...source(),
      latest: async (taskId) => {
        const checks = taskId === IMPL_A ? stored(CHECK_A, "prints-count", "sh checks/count.sh") : stored(CHECK_B, "stdout-empty", "sh checks/empty.sh");
        return { ...checks, files: [{ path: "checks/t.sh", content: file }] };
      },
    };
    const { first: sideA, second: sideB } = conflict.conflict;
    // Quote marks dropped; line endings and indentation are never the difference.
    const dropped = { ...conflict, conflict: { first: sideA, second: { ...sideB, requires: 'after=$(dsize "$D")\r\n   [ $((after * 2)) -lt $before ] || fail "store did not shrink"' } } };
    const spread = { ...conflict, conflict: { first: sideA, second: { ...sideB, requires: 'after=$(dsize "$D")\nbefore=$(dsize "$D")' } } };
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [dropped, spread] }, { problems: [] }], prompts), source: withFile, publicInterface: INTERFACE, judgements: keep() });
    expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean" });
    expect(prompts[1]).toContain(
      `Its line "[ $((after * 2)) -lt $before ] || fail \\"store did not shrink\\"" is in none of them; the stored line nearest it reads "[ $((after * 2)) -lt \\"$before\\" ] || fail \\"store did not shrink\\""`,
    );
    expect(prompts[1]).toContain("Each of its lines is stored, but not one after another: quote one run of consecutive lines.");
    // A quote whose lines differ from the file only by line endings and indentation is found.
    const spaced = { ...conflict, conflict: { first: sideA, second: { ...sideB, requires: 'after=$(dsize "$D")\r\n\t[ $((after * 2)) -lt "$before" ]' } } };
    const found: string[] = [];
    const agreed = new SuiteReviewer({ llm: scripted([{ problems: [spaced] }, { problems: [spaced] }], found), source: withFile, publicInterface: INTERFACE, judgements: keep() });
    expect(await agreed.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "problems" });
    expect(found).toHaveLength(2);
  });

  test("an answer that is not the schema is never read as a clean review", async () => {
    const reviewer = new SuiteReviewer({ llm: scripted([{ verdict: "looks fine" }]), source: source(), publicInterface: INTERFACE, judgements: keep() });
    await expect(reviewer.review(TASK, PROJECT_PATH)).rejects.toThrow();
  });

  test("a check task whose row records no item ids names its cited items by their place", async () => {
    const prompts: string[] = [];
    const legacy: SuiteReviewSource = {
      checkTasksUnderReview: async () => [{ id: CHECK_B, status: "Completed", checksFor: IMPL_B, visionItems: [REFUSAL.text], sources: null, checkedTitle: "Refuse bad rows", reviewReopens: 0 }],
      latest: async () => stored(CHECK_B, "stdout-empty", "sh checks/empty.sh"),
      frozen: async () => false,
    };
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [{ ...misread, judgedItems: ["item 1"] }] }, { problems: [] }], prompts), source: legacy, publicInterface: INTERFACE, judgements: keep() });
    expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean" });
    expect(prompts[0]).toContain(`- item 1: ${REFUSAL.text} (its id, status and kind are not recorded)`);
    expect(prompts[1]).toContain("but item 1 states it");
  });

  test("an unfinished check task fails the review instead of passing what it did not read", async () => {
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }]), source: source("Pending"), publicInterface: INTERFACE, judgements: keep() });
    await expect(reviewer.review(TASK, PROJECT_PATH)).rejects.toMatchObject({ name: "SuitesUnreadable" });
  });

  test("an Abandoned check task is set aside and the other suites are reviewed", async () => {
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }]), source: source("Abandoned"), publicInterface: INTERFACE, judgements: keep() });
    expect(await reviewer.review(TASK, PROJECT_PATH)).toEqual({ kind: "clean", reviewed: [CHECK_A], setAside: [CHECK_B], released: [], advisory: [], undecided: [], claim: RESAMPLED });
  });

  test("a review task with no vision items is refused before any model call", async () => {
    const prompts: string[] = [];
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }], prompts), source: source(), publicInterface: INTERFACE, judgements: keep() });
    await expect(reviewer.review({ ...TASK, taskSpec: { origin: "review" } }, PROJECT_PATH)).rejects.toMatchObject({ name: "SuitesUnreadable" });
    expect(prompts).toEqual([]);
  });

  // A reviewer that sees neither the cited Inferred assumptions nor the public
  // interface calls checks of those assumptions "outside the vision" and rejects names the interface fixed.
  test("each suite is judged against its own task's cited items, with their status, and the interface its checks were written against", async () => {
    const prompts: string[] = [];
    const reads: Array<{ path: string; commit: string }> = [];
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }], prompts), source: source(), publicInterface: interfaceAt(reads), judgements: keep() });

    await reviewer.review(TASK, PROJECT_PATH);

    // One read for the one baseline both suites share, of the project's own checkout.
    expect(reads).toEqual([{ path: PROJECT_PATH, commit: BASELINE }]);
    const prompt = prompts[0] ?? "";
    expect(prompt).toContain(`PUBLIC_INTERFACE.md at commit ${BASELINE}, the foundation the checks were written against`);
    expect(prompt).toContain(INTERFACE_TEXT);
    const [, suiteB = ""] = prompt.split(`## Check task ${CHECK_B}`);
    expect(suiteB).toContain("- A3 (assumption; client-visible behaviour): Malformed rows are refused with their line number");
    expect(prompt).toContain("- A4 (assumption; internal design, not citable): Totals are cached in totals.db");
    // The rule: inside its task's cited items, whatever their status; outside what none of them asks for.
    expect(prompt).toContain("a check that requires behaviour none of the vision items its own task cites asks for");
    expect(prompt).toContain("whatever their status or recorded kind: an Inferred\n  assumption the task cites is asked for");
    expect(prompt).toContain("Using a\n  form the public interface names (a command, an argument, a file, an exit status) is never outside");
  });

  // A rejection the cited text does not disprove is a judgement: it stands only when a second review
  // reaches it too, and it is told as a judgement, both reviews' clauses beside the cited text.
  const rowCount = {
    checkTasks: [CHECK_A],
    kind: "outside-vision",
    check: "prints-count",
    judgedItems: ["S1"],
    missingClause: "prints the row count",
    problem: "prints-count requires a row count no cited item asks for",
    evidence: "sh checks/count.sh",
  };

  test("a rejection both reviews reach is routed as the reviewers' judgement, each review's clause beside the cited text", async () => {
    const prompts: string[] = [];
    const recorded: Recorded[] = [];
    const secondClause = { ...rowCount, missingClause: "a count of the rows read" };
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [rowCount] }, { problems: [secondClause] }], prompts, TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });
    expect(await reviewer.review(TASK, PROJECT_PATH)).toEqual({
      kind: "problems",
      reviewed: [CHECK_A, CHECK_B],
      setAside: [],
      released: [],
      advisory: [],
      undecided: [],
      problems: [
        {
          checkTaskIds: [CHECK_A],
          kind: "outside-vision",
          problem:
            `${rowCount.problem} This is the reviewers' judgement, not a verified fact: two reviews each judged check ` +
            `"prints-count" to require behaviour none of its task's cited items asks for. The second was a review by another model ` +
            `family, other/other-strong, than the first's stub/stub-model. Side by side: the first review (stub/stub-model) judged it against S1 to require "prints the row count"; ` +
            `the second (other/other-strong) judged it against S1 to require "a count of the rows read"; cited S1: "${SCOPE.text}".`,
          evidence: rowCount.evidence,
        },
      ],
    });
    // The second review is a fresh call on the same prompt: it never sees the first verdict.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[1]).not.toContain(rowCount.missingClause);
    // Both judgements are recorded whole before the outcome is returned.
    expect(recorded).toEqual([
      {
        projectId: PROJECT,
        reviewTaskId: REVIEW_ID,
        judgements: [
          {
            checkTaskId: CHECK_A,
            check: "prints-count",
            outcome: "routed",
            basis: "two-reviews",
            first: rowCount,
            firstModel: STUB,
            second: [secondClause],
            secondReview: { strength: "other-family", first: STUB, second: OTHER_FAMILY },
            passedOver: [],
            secondFailure: null,
            undecided: null,
          },
        ],
        claim: null,
      },
    ]);
  });

  test("a rejection the same model reaches again from the other angle is routed, and the text says it shares every blind spot", async () => {
    const asked: unknown[] = [];
    const recorded: Recorded[] = [];
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [rowCount] }, { problems: [rowCount] }], [], ONE_MODEL, asked), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });
    const outcome = await reviewer.review(TASK, PROJECT_PATH);
    expect(asked).toEqual([undefined, "other-family", "same-family-other-model", "same-model"]);
    if (outcome.kind !== "problems") return expect.unreachable("an agreed rejection is routed");
    expect(outcome.problems[0]?.problem).toContain("The second was the first review's model stub/stub-model asked again from another angle, which shares every blind spot of the first.");
    expect(recorded[0]?.judgements[0]?.secondReview).toEqual({ strength: "same-model", first: STUB, second: STUB });
  });

  test("a paraphrased false rejection the second review does not reach is released as passing review, both judgements kept", async () => {
    const prompts: string[] = [];
    const recorded: Recorded[] = [];
    const paraphrase = {
      checkTasks: [CHECK_B],
      kind: "outside-vision",
      check: "stdout-empty",
      judgedItems: ["A3"],
      missingClause: "refuses malformed rows with a line number",
      problem: "stdout-empty requires refusing malformed rows, which no cited item asks for",
      evidence: "sh checks/empty.sh",
    };
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [paraphrase] }, { problems: [] }], prompts, TWO_FAMILIES), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });
    expect(await reviewer.review(TASK, PROJECT_PATH)).toEqual({
      kind: "clean",
      reviewed: [CHECK_A, CHECK_B],
      setAside: [],
      released: [
        {
          checkTaskId: CHECK_B,
          check: "stdout-empty",
          first: `check "stdout-empty" is outside the vision, requiring "${paraphrase.missingClause}": ${paraphrase.problem}`,
          second: [],
          secondReview: "a review by another model family, other/other-strong, than the first's stub/stub-model",
        },
      ],
      advisory: [],
      undecided: [],
      claim: CONFIRMED,
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(prompts[0]);
    expect(recorded[0]?.judgements).toEqual([expect.objectContaining({ checkTaskId: CHECK_B, outcome: "released", first: paraphrase, second: [] })]);
  });

  test("judgements that cannot be recorded fail the review: nothing is released or routed on them", async () => {
    const reviewer = new SuiteReviewer({
      llm: scripted([{ problems: [rowCount] }, { problems: [] }]),
      source: source(),
      publicInterface: INTERFACE,
      judgements: {
        record: async () => {
          throw new Error("connection terminated");
        },
      },
    });
    await expect(reviewer.review(TASK, PROJECT_PATH)).rejects.toMatchObject({ name: "SuiteJudgementsUnrecorded", message: expect.stringMatching(/could not be recorded: .*connection terminated/) });
  });

  test("a second review that rejects a different check of the task does not confirm the first's rejection", async () => {
    const other = { ...rowCount, checkTasks: [CHECK_B], check: "stdout-empty", judgedItems: ["A3"], missingClause: "prints nothing" };
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [rowCount] }, { problems: [other] }]), source: source(), publicInterface: INTERFACE, judgements: keep() });
    const outcome = await reviewer.review(TASK, PROJECT_PATH);
    expect(outcome).toMatchObject({ kind: "clean", released: [{ checkTaskId: CHECK_A, check: "prints-count", second: [] }] });
  });

  test("a rejection naming a check its check task did not write is re-asked", async () => {
    const prompts: string[] = [];
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [{ ...rowCount, check: "ghost-check" }] }, { problems: [] }], prompts), source: source(), publicInterface: INTERFACE, judgements: keep() });
    expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean" });
    expect(prompts[1]).toContain(`judged check "ghost-check", which check task ${CHECK_A} did not write (it wrote [prints-count])`);
  });

  // A model shown an item whole can still read half of it and reject a check the other half requires.
  const misread = {
    checkTasks: [CHECK_B],
    kind: "outside-vision",
    check: "stdout-empty",
    judgedItems: ["A3"],
    missingClause: "Refused, with their line-number",
    problem: "stdout-empty requires refusing malformed rows with a line number, which no cited item asks for",
    evidence: "sh checks/empty.sh",
  };

  test("a rejection whose clause a cited item states is discarded and re-asked, so every review of the check reaches the same verdict", async () => {
    for (let review = 0; review < 2; review++) {
      const prompts: string[] = [];
      const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [misread] }, { problems: [] }], prompts), source: source(), publicInterface: INTERFACE, judgements: keep() });

      expect(await reviewer.review(TASK, PROJECT_PATH)).toEqual({ kind: "clean", reviewed: [CHECK_A, CHECK_B], setAside: [], released: [], advisory: [], undecided: [], claim: RESAMPLED });
      // The misread, its re-ask, and the second review.
      expect(prompts).toHaveLength(3);
      expect(prompts[1]).toContain(`but A3 states it: "${REFUSAL.text}"`);
    }
  });

  test("a rejection the cited text contradicts on every attempt is never acted on", async () => {
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [misread] }]), source: source(), publicInterface: INTERFACE, judgements: keep() });
    await expect(reviewer.review(TASK, PROJECT_PATH)).rejects.toBeInstanceOf(StructuredOutputExhausted);
  });

  test("a rejection that judged an item its check task does not cite is re-asked", async () => {
    const prompts: string[] = [];
    const elsewhere = { ...misread, judgedItems: ["S1"], missingClause: "an empty stdout" };
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [elsewhere] }, { problems: [] }], prompts), source: source(), publicInterface: INTERFACE, judgements: keep() });
    expect(await reviewer.review(TASK, PROJECT_PATH)).toMatchObject({ kind: "clean" });
    expect(prompts[1]).toContain(`judged item "S1", which check task ${CHECK_B} does not cite (it cites [A3])`);
  });

  test("an outside-vision finding without the item it judged or the clause it says is missing is no verdict", async () => {
    const { missingClause: _clause, ...unquoted } = misread;
    const { judgedItems: _items, ...unjudged } = misread;
    for (const finding of [unquoted, unjudged, { ...misread, missingClause: " -- " }]) {
      const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [finding] }]), source: source(), publicInterface: INTERFACE, judgements: keep() });
      await expect(reviewer.review(TASK, PROJECT_PATH)).rejects.toThrow();
    }
  });

  test("an interface that cannot be read fails the review before any model call", async () => {
    const prompts: string[] = [];
    const broken: PublicInterfaceReader = {
      at: async () => {
        throw new Error("fatal: bad object");
      },
    };
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }], prompts), source: source(), publicInterface: broken, judgements: keep() });
    await expect(reviewer.review(TASK, PROJECT_PATH)).rejects.toMatchObject({ name: "SuitesUnreadable" });
    expect(prompts).toEqual([]);
  });

  test("a refused model call propagates as the refusal", async () => {
    const refusal = new PreCallRefusal("budget_cap: refused");
    const reviewer = new SuiteReviewer({ llm: scripted([refusal]), source: source(), publicInterface: INTERFACE, judgements: keep() });
    await expect(reviewer.review(TASK, PROJECT_PATH)).rejects.toBe(refusal);
  });
});

describe("gitPublicInterface", () => {
  test("reads PUBLIC_INTERFACE.md as it stood at the commit, absent where that commit has none", async () => {
    const repo = await mkdtemp(join(tmpdir(), "public-interface-test-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
      git("init", "-q", "-b", "main");
      await writeFile(join(repo, "README"), "x\n");
      git("add", "-A");
      git("commit", "-q", "-m", "before");
      const before = git("rev-parse", "HEAD");
      await writeFile(join(repo, "PUBLIC_INTERFACE.md"), "Run: kv put <key> <value>\n");
      git("add", "-A");
      git("commit", "-q", "-m", "scaffold");
      const scaffold = git("rev-parse", "HEAD");
      await writeFile(join(repo, "PUBLIC_INTERFACE.md"), "changed later\n");
      git("commit", "-q", "-am", "later");

      expect(await gitPublicInterface.at(repo, scaffold)).toEqual({ kind: "present", text: "Run: kv put <key> <value>\n" });
      expect(await gitPublicInterface.at(repo, before)).toEqual({ kind: "absent" });
      await expect(gitPublicInterface.at(repo, "--output=/tmp/x")).rejects.toMatchObject({ name: "BaselineCommitInvalid" });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

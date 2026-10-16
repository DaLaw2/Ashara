import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PreCallRefusal } from "@ashara/finance";
import type { ContextualLlm } from "@ashara/finance";
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

function stored(checkTaskId: string, name: string, command: string): TaskChecks {
  return { checkTaskId, revision: 1, environmentVersion: "v1", baselineCommit: BASELINE, checks: [{ name, command }], files: [{ path: "checks/t.sh", content: "exit 1" }] };
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

function source(statusB = "Completed"): SuiteReviewSource {
  return {
    checkTasksUnderReview: async () => [
      { id: CHECK_A, status: "Completed", checksFor: IMPL_A, visionItems: [SCOPE.text], sources: [SCOPE], checkedTitle: "Sum by month" },
      { id: CHECK_B, status: statusB, checksFor: IMPL_B, visionItems: [REFUSAL.text], sources: [REFUSAL], checkedTitle: "Refuse bad rows" },
    ],
    latest: async (taskId) => (taskId === IMPL_A ? stored(CHECK_A, "prints-count", "sh checks/count.sh") : stored(CHECK_B, "stdout-empty", "sh checks/empty.sh")),
  };
}

/**
 * Answers every structured call with the next scripted answer, parsed by the request's own schema.
 * A request for a second opinion is answered by `other` when given, as a catalog with another model
 * at the capability would; else by the same model again.
 */
function scripted(answers: unknown[], prompts: string[] = [], other: { provider: string; model: string } | null = null, asked: unknown[] = []): ContextualLlm {
  let next = 0;
  return {
    forCall: () => ({
      generateStructured: async (request) => {
        prompts.push(request.prompt);
        asked.push(request.otherThan);
        const answer = answers[Math.min(next, answers.length - 1)];
        next++;
        if (answer instanceof Error) throw answer;
        const by = request.otherThan !== undefined && other !== null ? other : { provider: "stub", model: "stub-model" };
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

describe("SuiteReviewer (ADR-074 addendum 2 d71 c)", () => {
  test("a clean verdict is accepted after its schema validates; the prompt holds every suite and the vision", async () => {
    const prompts: string[] = [];
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }], prompts), source: source(), publicInterface: INTERFACE, judgements: keep() });

    expect(await reviewer.review(TASK, PROJECT_PATH)).toEqual({ kind: "clean", reviewed: [CHECK_A, CHECK_B], setAside: [], released: [] });
    expect(prompts).toHaveLength(1);
    for (const text of [...VISION, `## Check task ${CHECK_A}`, `## Check task ${CHECK_B}`, "sh checks/count.sh", "sh checks/empty.sh", "--- file checks/t.sh"]) {
      expect(prompts[0]).toContain(text);
    }
  });

  test("problems come back with the check tasks they name", async () => {
    const problem = { checkTasks: [CHECK_A, CHECK_B], kind: "contradiction", problem: "a prints a count, b requires empty stdout", evidence: "count.sh; empty.sh" };
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [problem] }]), source: source(), publicInterface: INTERFACE, judgements: keep() });

    expect(await reviewer.review(TASK, PROJECT_PATH)).toEqual({
      kind: "problems",
      reviewed: [CHECK_A, CHECK_B],
      setAside: [],
      released: [],
      problems: [{ checkTaskIds: [CHECK_A, CHECK_B], kind: "contradiction", problem: problem.problem, evidence: problem.evidence }],
    });
  });

  test("a verdict naming a check task it did not read is re-asked, and one that never validates gives no verdict", async () => {
    const prompts: string[] = [];
    const ghost = { problems: [{ checkTasks: ["ghost"], kind: "contradiction", problem: "p", evidence: "e" }] };
    const reviewer = new SuiteReviewer({ llm: scripted([ghost], prompts), source: source(), publicInterface: INTERFACE, judgements: keep() });

    await expect(reviewer.review(TASK, PROJECT_PATH)).rejects.toBeInstanceOf(StructuredOutputExhausted);
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[1]).toContain('names check task "ghost"');
  });

  test("an answer that is not the schema is never read as a clean review", async () => {
    const reviewer = new SuiteReviewer({ llm: scripted([{ verdict: "looks fine" }]), source: source(), publicInterface: INTERFACE, judgements: keep() });
    await expect(reviewer.review(TASK, PROJECT_PATH)).rejects.toThrow();
  });

  test("a check task whose row records no item ids names its cited items by their place", async () => {
    const prompts: string[] = [];
    const legacy: SuiteReviewSource = {
      checkTasksUnderReview: async () => [{ id: CHECK_B, status: "Completed", checksFor: IMPL_B, visionItems: [REFUSAL.text], sources: null, checkedTitle: "Refuse bad rows" }],
      latest: async () => stored(CHECK_B, "stdout-empty", "sh checks/empty.sh"),
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
    expect(await reviewer.review(TASK, PROJECT_PATH)).toEqual({ kind: "clean", reviewed: [CHECK_A], setAside: [CHECK_B], released: [] });
  });

  test("a review task with no vision items is refused before any model call", async () => {
    const prompts: string[] = [];
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [] }], prompts), source: source(), publicInterface: INTERFACE, judgements: keep() });
    await expect(reviewer.review({ ...TASK, taskSpec: { origin: "review" } }, PROJECT_PATH)).rejects.toMatchObject({ name: "SuitesUnreadable" });
    expect(prompts).toEqual([]);
  });

  // ADR-074 addendum 2 d89 B: a reviewer that sees neither the cited Inferred assumptions nor the public
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
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [rowCount] }, { problems: [secondClause] }], prompts), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });
    expect(await reviewer.review(TASK, PROJECT_PATH)).toEqual({
      kind: "problems",
      reviewed: [CHECK_A, CHECK_B],
      setAside: [],
      released: [],
      problems: [
        {
          checkTaskIds: [CHECK_A],
          kind: "outside-vision",
          problem:
            `${rowCount.problem} This is the reviewers' judgement, not a verified fact: two reviews each judged check ` +
            `"prints-count" to require behaviour none of its task's cited items asks for. The second was a re-sample of the ` +
            `first review's model stub/stub-model, so not an independent ` +
            `judgement. Side by side: the first review (stub/stub-model) judged it against S1 to require "prints the row count"; ` +
            `the second (stub/stub-model) judged it against S1 to require "a count of the rows read"; cited S1: "${SCOPE.text}".`,
          evidence: rowCount.evidence,
        },
      ],
    });
    // The second review is a fresh call on the same prompt: it never sees the first verdict.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[1]).not.toContain(rowCount.missingClause);
    // Both judgements are recorded whole before the outcome is returned.
    const model = { provider: "stub", model: "stub-model" };
    expect(recorded).toEqual([
      {
        projectId: PROJECT,
        reviewTaskId: REVIEW_ID,
        judgements: [
          { checkTaskId: CHECK_A, check: "prints-count", outcome: "routed", first: rowCount, second: [secondClause], secondReview: { kind: "re-sample", first: model, second: model } },
        ],
      },
    ]);
  });

  test("the second review is asked of another model when the catalog has one, and is named as that model", async () => {
    const asked: unknown[] = [];
    const recorded: Recorded[] = [];
    const other = { provider: "other", model: "other-strong" };
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [rowCount] }, { problems: [rowCount] }], [], other, asked), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });
    const outcome = await reviewer.review(TASK, PROJECT_PATH);
    expect(asked).toEqual([undefined, { provider: "stub", model: "stub-model" }]);
    if (outcome.kind !== "problems") return expect.unreachable("an agreed rejection is routed");
    expect(outcome.problems[0]?.problem).toContain("The second was a review by a different model, other/other-strong, than the first's stub/stub-model.");
    expect(outcome.problems[0]?.problem).not.toContain("independent");
    expect(recorded[0]?.judgements[0]?.secondReview).toEqual({ kind: "other-model", first: { provider: "stub", model: "stub-model" }, second: other });
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
    const reviewer = new SuiteReviewer({ llm: scripted([{ problems: [paraphrase] }, { problems: [] }], prompts), source: source(), publicInterface: INTERFACE, judgements: keep(recorded) });
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
          secondReview: "a re-sample of the first review's model stub/stub-model, so not an independent judgement",
        },
      ],
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

      expect(await reviewer.review(TASK, PROJECT_PATH)).toEqual({ kind: "clean", reviewed: [CHECK_A, CHECK_B], setAside: [], released: [] });
      expect(prompts).toHaveLength(2);
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

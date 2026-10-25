import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { DomainEvent } from "@ashara/shared";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { memoryStepContainment, notExercised, recordingLogger } from "@ashara/shared/testing";
import type { StoredBlockedReason } from "./work-item-language/blocked-reason.js";
import type { WorkItemStatus } from "./work-item-language/work-item-status.js";
import { BLOCKED_REASON_SOURCES, blockedExitOf } from "./work-item-language/blocked-reason.js";
import { InvalidStatusTransition } from "./work-item-language/transitions.js";
import type { WorkItem, WorkItemRepository } from "./domain/index.js";
import type { ProjectBlockCause } from "./project-halt.js";
import { releaseClearedBlocks } from "./parked-exits.js";
import { inertWorkItemRepo, itemLockOver } from "./domain/testing.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000a1", "test");

function blocked(reason: StoredBlockedReason | undefined): WorkItem {
  return {
    id: createWorkItemId(),
    level: "Task",
    status: "Blocked",
    title: "t",
    projectId: PROJECT,
    overflowedWindowTokens: null,
    failureVerdict: { kind: "none" },
    dispatchCount: 1,
    workKind: "implementation",
    repairsTaskId: null,
    blockedReason: reason,
    createdAt: new Date(),
    updatedAt: new Date(),
    events: [],
  };
}

/** The read of a task under its charge's row lock failed. */
class LockedReadFailed extends Error {
  constructor(readonly taskId: string) {
    super(`the row of task ${taskId} could not be read under its lock`);
    this.name = "LockedReadFailed";
  }
}

/** The client's side of a held task's question: whether it can be asked, and whether its answer is read. */
interface ClientSide {
  readonly askable: boolean;
  readonly answered: boolean;
}

function run(
  items: WorkItem[],
  saveRefused = false,
  recordMergeCommit: WorkItemRepository["recordMergeCommit"] = notExercised("recordMergeCommit"),
  workspacePath: string | null = null,
  client: ClientSide = { askable: true, answered: true },
  faultsBefore = 0,
  duringRead: () => void = () => undefined,
  lockedRead?: WorkItemRepository["findById"],
) {
  let faults = faultsBefore;
  // Every write of a charge, in the order the ledger took it: what a test asserts was not charged.
  const charged: string[] = [];
  const logger = recordingLogger();
  // Every fault escapes the step but a locked read's that a test throws, which the step contains.
  const containment = memoryStepContainment((error) => !(error instanceof LockedReadFailed));
  const saves: Array<{ id: string; prev: WorkItemStatus; status: WorkItemStatus; reason: unknown }> = [];
  const published: Array<Pick<DomainEvent, "eventType">> = [];
  const asked: string[] = [];
  const posted = new Set<string>();
  const blocks: Array<{ readonly projectId: string; readonly cause: ProjectBlockCause }> = [];
  const findById: WorkItemRepository["findById"] = async (id) => {
    const found = items.find((i) => i.id === id);
    return found === undefined ? null : { ...found, events: [] };
  };
  const block = async (projectId: string, cause: ProjectBlockCause): Promise<"blocked"> => {
    blocks.push({ projectId, cause });
    return "blocked";
  };
  const workItemRepo: WorkItemRepository = inertWorkItemRepo({
    findByProjectAndStatus: async (_projectId, status) => items.filter((i) => i.status === status).map((i) => ({ ...i, events: [] })),
    findById,
    withItemLocked: itemLockOver(lockedRead ?? findById, {
      recordInfrastructureFault: async (id) => {
        charged.push(`fault:${id}`);
        return ++faults;
      },
      blockProject: async (projectId, cause) => {
        charged.push(`halt:${projectId}`);
        return block(projectId, cause);
      },
    }),
    listByProject: async () => items.map((i) => ({ ...i, events: [] })),
    listDependenciesByProject: async () => [],
    save: async (item, prev) => {
      if (saveRefused) throw new InvalidStatusTransition(item.id, "Abandoned", item.status);
      saves.push({ id: item.id, prev, status: item.status, reason: item.blockedReason });
    },
    saveRefundedOverflow: async () => 0,
    recordCrashOrphan: async () => 1,
    recordMergeCommit,
  });
  const released = releaseClearedBlocks({
    workItemRepo,
    eventStore: { publish: async (event) => void published.push(event) },
    projects: {
      listActiveIds: async () => [PROJECT],
      get: async () => {
        duringRead();
        return { workspacePath };
      },
      block,
    },
    clientQuestions: {
      ask: async (question) => {
        asked.push(question.questionId);
        if (!client.askable) return { kind: "not-askable", why: "the project is not at work" };
        if (posted.has(question.questionId)) return { kind: "on-record", questionId: question.questionId };
        posted.add(question.questionId);
        return { kind: "posted", questionId: question.questionId, assumptionKey: "A9", visionVersion: 2 };
      },
      answered: async () => client.answered,
    },
    workdirBase: tmpdir(),
    containment,
    logger,
  });
  return { released, saves, published, asked, blocks, charged, faults: () => faults, logger, containment };
}

const repos: string[] = [];
afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function repoWith(subject: string): { readonly path: string; readonly head: string } {
  const path = mkdtempSync(join(tmpdir(), "ashara-parked-"));
  repos.push(path);
  gitIn(path, "init", "-q", "-b", "main");
  gitIn(path, "commit", "-q", "--allow-empty", "-m", subject);
  return { path, head: gitIn(path, "rev-parse", "HEAD") };
}

/**
 * What a dispatch that never released its checkout leaves: the task's branch, holding a commit main
 * never took, checked out in its worktree slot under the workdir base. `left` reads both back.
 */
function heldCheckout(target: string, taskId: string): () => { readonly branch: string; readonly worktree: boolean } {
  const workDir = join(tmpdir(), `task-${taskId}`);
  repos.push(workDir);
  gitIn(target, "worktree", "add", "-q", workDir, "-b", `task/${taskId}`, "main");
  gitIn(workDir, "commit", "-q", "--allow-empty", "-m", "the agent's work");
  return () => ({ branch: gitIn(target, "branch", "--list", "--format=%(refname:short)", `task/${taskId}`), worktree: existsSync(workDir) });
}

// An owner_unresolved block cannot wait on a newer roster revision, which no production path
// writes (Organization's recordFirstRoster refuses any revision but 1).
describe("a Blocked owner_unresolved or environment_undefined task is given up, never left waiting", () => {
  test.each<StoredBlockedReason>([
    { source: "owner_unresolved", ownerRoleId: "role-1", rosterRevision: 1, reason: "not in roster" },
    { source: "owner_unresolved", ownerRoleId: null, rosterRevision: null, reason: "the work item has no owner role" },
    { source: "environment_undefined", reason: "no statement" },
  ])("$source: Abandoned with its cause and its given_up event, for a plan repair", async (reason) => {
    const item = blocked(reason);
    const { released, saves, published } = run([item]);

    expect(await released).toBe(1);
    expect(saves).toEqual([{ id: item.id, prev: "Blocked", status: "Abandoned", reason }]);
    expect(published.map((e) => e.eventType)).toEqual(["work_item.given_up"]);
  });
});

describe("merge_unrecorded leaves Blocked to Completed once its merge record is written", () => {
  const MERGE = "0123456789abcdef0123456789abcdef01234567";
  const unrecorded: StoredBlockedReason = { source: "merge_unrecorded", mergeCommit: MERGE, reason: "connection lost" };

  test("the record is written again and the item is Completed, never Pending", async () => {
    const item = blocked(unrecorded);
    const records: string[] = [];
    const { released, saves, published } = run([item], false, async (id, commit) => void records.push(`${id}:${commit}`));

    expect(await released).toBe(1);
    expect(records).toEqual([`${item.id}:${MERGE}`]);
    expect(saves).toEqual([{ id: item.id, prev: "Blocked", status: "Completed", reason: undefined }]);
    expect(published.map((e) => e.eventType)).toEqual(["work_item.completed"]);
  });

  test("once the record holds, the worktree and branch no dispatch released are gone, a completion lost to a concurrent write included", async () => {
    for (const saveRefused of [false, true]) {
      const item = blocked(unrecorded);
      const main = repoWith("initial");
      const left = heldCheckout(main.path, item.id);

      const { released } = run([item], saveRefused, async () => undefined, main.path);

      expect(await released).toBe(saveRefused ? 0 : 1);
      expect(left()).toEqual({ branch: "", worktree: false });
    }
  });

  test("a record that still fails leaves it Blocked for the next cycle", async () => {
    const { released, saves } = run([blocked(unrecorded)], false, async () => {
      throw new Error("connection lost");
    });

    expect(await released).toBe(0);
    expect(saves).toEqual([]);
  });
});

// No work item waits on a person.
describe("no Blocked item is left with an exit only a person takes", () => {
  const MERGE = "0123456789abcdef0123456789abcdef01234567";
  // Keyed by every source: a source added to StoredBlockedReason fails to compile here until it is listed.
  const SAMPLE: { readonly [S in StoredBlockedReason["source"]]: Extract<StoredBlockedReason, { source: S }> } = {
    task_failed: { source: "task_failed", reason: "x" },
    orchestrator_error: { source: "orchestrator_error", reason: "x" },
    replan: { source: "replan", replanContext: { attempt: 1, detail: "x", raw: {} } },
    failure_given_up: { source: "failure_given_up", reason: "x" },
    environment_unavailable: { source: "environment_unavailable", unavailable: "podman", reason: "down" },
    environment_undefined: { source: "environment_undefined", reason: "no statement" },
    checks_stale: { source: "checks_stale", checkTaskId: "c", reason: "stale" },
    environment_change_needed: { source: "environment_change_needed", paths: ["environment/environment.toml"], reason: "edited" },
    owner_unresolved: { source: "owner_unresolved", ownerRoleId: "role-1", rosterRevision: 1, reason: "not in roster" },
    checks_rewrite_bound: { source: "checks_rewrite_bound", checkTaskId: "c", revision: 3, bound: 2, reason: "stale again" },
    check_disputed: { source: "check_disputed", checkTaskId: "c", checkName: "n", reason: "disputed" },
    suite_review_unresolved: { source: "suite_review_unresolved", checkTaskIds: ["c"], reason: "problems" },
    work_budget_spent: { source: "work_budget_spent", budgetRequests: 60, drawnRequests: 60, reason: "spent" },
    context_window_exceeded: {
      source: "context_window_exceeded", provider: "p", model: "m", windowTokens: 32_000, outputReserveTokens: 16_384, projectedInputTokens: null, reason: "no larger window",
    },
    no_wider_model: { source: "no_wider_model", overflowedWindowTokens: 32_000, reason: "no larger window in the catalog" },
    crash_loop: { source: "crash_loop", boots: 2, bound: 2, reason: "died twice" },
    dependency_unsatisfiable: { source: "dependency_unsatisfiable", blockedBy: ["x"], reason: "abandoned" },
    merge_unrecorded: { source: "merge_unrecorded", mergeCommit: MERGE, reason: "connection lost" },
    orphan_unreconciled: { source: "orphan_unreconciled", faultClass: "ashara", step: "requeue the task", reason: "connection lost" },
    correction_pending: { source: "correction_pending", visionVersion: 3, affected: ["G2"], reason: "held" },
    superseded: { source: "superseded", planRevision: 2, requestedBy: null, reason: "replaced" },
    acceptance_failed: { source: "acceptance_failed", mainCommit: MERGE, reason: "check failed on main" },
    awaiting_work: { source: "awaiting_work", waits: 1, interfaceEntries: ["I10"], on: ["t"], reason: "needs I10" },
    awaiting_client: { source: "awaiting_client", waits: 1, questionId: "q", question: "which command?", assumption: "the tender's command", reason: "contradiction" },
    client_answered: { source: "client_answered", waits: 1, questionId: "q", reason: "answered" },
    prerequisite_unresolved: { source: "prerequisite_unresolved", why: "unplanned", waits: 0, reason: "no task delivers I10" },
    api: { source: "api" },
  };
  // Each exit names the production code that takes it; a new exit kind fails to compile here until
  // its writer is named. None is a person, and none waits on a write no production path makes.
  const WRITER: { readonly [K in ReturnType<typeof blockedExitOf>["kind"]]: string } = {
    "merge-recorded": "parked-exits.ts completeRecordedMerge: WorkItemRepository.recordMergeCommit, then completeRecordedMerge to Completed",
    "read-main": "parked-exits.ts settleOnMain: readMainForMerge reads main; none found (no target here), release: returnToPending, unblockWorkItem to Pending",
    requeue: "parked-exits.ts settleOnMain: readMainForMerge reads main; none found (no target here), release: returnToPending, unblockWorkItem to Pending",
    "await-revision": "replan.ts Replanner.compose: supersedeWorkItem to Abandoned, in the plan revision the replanning step writes for the correction holding it",
    "await-answer": "parked-exits.ts awaitAnswer: the question posted if not on record, then once the client's answer is read readMainForMerge reads main and returnToPending, resumeOnAnswer to Pending",
    "give-up": "parked-exits.ts giveUp: giveUpWorkItem to Abandoned; the plan_repair_on_abandon trigger opens the repair the Replanner answers",
  };
  const LEAVES_TO: { readonly [K in ReturnType<typeof blockedExitOf>["kind"]]: WorkItemStatus } = {
    "merge-recorded": "Completed",
    "read-main": "Pending",
    requeue: "Pending",
    "await-revision": "Abandoned",
    "await-answer": "Pending",
    "give-up": "Abandoned",
  };

  test("every blocked-reason source leaves Blocked in the next sweep, through the production writer of its exit", async () => {
    for (const source of BLOCKED_REASON_SOURCES) {
      const exit = blockedExitOf(SAMPLE[source]).kind;
      const recorded: string[] = [];
      const { released, saves } = run([blocked(SAMPLE[source])], false, async (id) => void recorded.push(id));
      if (exit === "await-revision") {
        // The replanning step, not this sweep, takes its exit: the sweep leaves it for the revision.
        expect(WRITER[exit], source).toMatch(/^replan\.ts /);
        expect(LEAVES_TO[exit], source).toBe("Abandoned");
        expect(await released, source).toBe(0);
        expect(saves, source).toEqual([]);
        continue;
      }

      expect(WRITER[exit], source).toMatch(/^parked-exits\.ts /);
      expect(await released, `${source} (${WRITER[exit]})`).toBe(1);
      expect(saves.map((save) => save.status), source).toEqual([LEAVES_TO[exit]]);
      expect(recorded, source).toHaveLength(exit === "merge-recorded" ? 1 : 0);
    }
  });

  test("a Blocked item with no reason at all is given up too", async () => {
    const { released, saves } = run([blocked(undefined)]);
    expect(await released).toBe(1);
    expect(saves).toEqual([expect.objectContaining({ status: "Abandoned", reason: expect.objectContaining({ source: "orchestrator_error" }) })]);
  });

  test("only a merge-record wait, an unreadable main, a correction's hold or a client's answer awaited stays Blocked past its sweep; every other source requeues or is given up", () => {
    const waiting = BLOCKED_REASON_SOURCES.filter((source) => {
      const exit = blockedExitOf(SAMPLE[source]);
      return exit.kind !== "requeue" && exit.kind !== "give-up";
    });
    expect([...waiting]).toEqual(["merge_unrecorded", "orphan_unreconciled", "correction_pending", "awaiting_client"]);
  });

  test("an infrastructure block from a legacy row goes back to Pending at once, unblocked by its automatic exit", async () => {
    const { released, saves, published } = run([blocked(SAMPLE.environment_unavailable)]);
    expect(await released).toBe(1);
    expect(saves).toEqual([expect.objectContaining({ status: "Pending", reason: undefined })]);
    expect(published.map((e) => e.eventType)).toEqual(["work_item.unblocked"]);
  });

  test.each<StoredBlockedReason>([
    SAMPLE.environment_change_needed,
    SAMPLE.checks_stale,
    SAMPLE.checks_rewrite_bound,
    SAMPLE.check_disputed,
    SAMPLE.suite_review_unresolved,
    SAMPLE.dependency_unsatisfiable,
    SAMPLE.api,
  ])("$source: the task is given up with its cause, for a plan repair", async (reason) => {
    const { released, saves, published } = run([blocked(reason)]);

    expect(await released).toBe(1);
    expect(saves).toEqual([expect.objectContaining({ prev: "Blocked", status: "Abandoned", reason })]);
    expect(published.map((e) => e.eventType)).toEqual(["work_item.given_up"]);
  });
});

test("a give-up that loses a race to a concurrent write is not counted", async () => {
  const { released, published } = run([blocked({ source: "owner_unresolved", ownerRoleId: "role-1", rosterRevision: 1, reason: "not in roster" })], true);

  expect(await released).toBe(0);
  expect(published).toEqual([]);
});

describe("orphan_unreconciled reads main again before it leaves Blocked", () => {
  const unreconciled: StoredBlockedReason = { source: "orphan_unreconciled", faultClass: "ashara", step: "read main for the task's merge", reason: "git failed" };

  test("its merge is on main now: recorded and Completed, never Pending; the dead process's worktree and branch are gone", async () => {
    const item = blocked(unreconciled);
    const main = repoWith(`merge: task ${item.id}`);
    const left = heldCheckout(main.path, item.id);
    const records: string[] = [];
    const { released, saves } = run([item], false, async (id, commit) => void records.push(`${id}:${commit}`), main.path);

    expect(await released).toBe(1);
    expect(records).toEqual([`${item.id}:${main.head}`]);
    expect(saves).toEqual([{ id: item.id, prev: "Blocked", status: "Completed", reason: undefined }]);
    expect(left()).toEqual({ branch: "", worktree: false });
  });

  test("main still cannot be read: it stays Blocked, never requeued blind, the read counted on its fault budget and no halt within it", async () => {
    const unreadable = mkdtempSync(join(tmpdir(), "ashara-parked-"));
    repos.push(unreadable);
    mkdirSync(join(unreadable, ".git"));
    const { released, saves, blocks, faults } = run([blocked(unreconciled)], false, notExercised("recordMergeCommit"), unreadable);

    expect(await released).toBe(0);
    expect(saves).toEqual([]);
    expect(faults()).toBe(1);
    expect(blocks).toEqual([]);
  });

  test("main still cannot be read past the fault budget: it stays Blocked and the project halts on Ashara's own fault", async () => {
    const unreadable = mkdtempSync(join(tmpdir(), "ashara-parked-"));
    repos.push(unreadable);
    mkdirSync(join(unreadable, ".git"));
    const { released, saves, blocks, faults } = run([blocked(unreconciled)], false, notExercised("recordMergeCommit"), unreadable, undefined, 3);

    expect(await released).toBe(0);
    expect(saves).toEqual([]);
    expect(faults()).toBe(4);
    expect(blocks).toEqual([{ projectId: PROJECT, cause: expect.objectContaining({ category: "fault", errorClass: "OrphanUnreconciled" }) }]);
  });

  test("main unread while the owner abandons it during the read: neither counted on its fault budget nor its project halted", async () => {
    const unreadable = mkdtempSync(join(tmpdir(), "ashara-parked-"));
    repos.push(unreadable);
    mkdirSync(join(unreadable, ".git"));
    const items = [blocked(unreconciled)];
    const abandon = (): void => void items.splice(0, 1, ...items.map((each) => ({ ...each, status: "Abandoned" as const })));
    const { released, saves, blocks, charged, faults } = run(items, false, notExercised("recordMergeCommit"), unreadable, undefined, 3, abandon);

    expect(await released).toBe(0);
    expect(charged).toEqual([]);
    expect(saves).toEqual([]);
    expect(faults()).toBe(3);
    expect(blocks).toEqual([]);
  });

  test("main unread and the task read Abandoned under the charge's lock only: the ledger takes no write", async () => {
    const unreadable = mkdtempSync(join(tmpdir(), "ashara-parked-"));
    repos.push(unreadable);
    mkdirSync(join(unreadable, ".git"));
    const item = blocked(unreconciled);
    const abandonedUnderLock = async (): Promise<WorkItem> => ({ ...item, status: "Abandoned", events: [] });
    const { released, saves, blocks, charged } = run([item], false, notExercised("recordMergeCommit"), unreadable, undefined, 3, undefined, abandonedUnderLock);

    expect(await released).toBe(0);
    expect(charged).toEqual([]);
    expect(saves).toEqual([]);
    expect(blocks).toEqual([]);
  });

  test("main unread and the task gone under the charge's lock: warned of, neither counted on its fault budget nor its project halted", async () => {
    const unreadable = mkdtempSync(join(tmpdir(), "ashara-parked-"));
    repos.push(unreadable);
    mkdirSync(join(unreadable, ".git"));
    const item = blocked(unreconciled);
    const { released, saves, blocks, faults, logger } = run([item], false, notExercised("recordMergeCommit"), unreadable, undefined, 0, undefined, async () => null);

    expect(await released).toBe(0);
    expect(saves).toEqual([]);
    expect(faults()).toBe(0);
    expect(blocks).toEqual([]);
    expect(logger.records).toContainEqual(expect.objectContaining({ level: "warn", event: "delivery.item-vanished", fields: expect.objectContaining({ taskId: item.id }) }));
  });

  test("main unread and the read under the charge's lock failing: the fault is the project's, contained to it, and nothing is charged", async () => {
    const unreadable = mkdtempSync(join(tmpdir(), "ashara-parked-"));
    repos.push(unreadable);
    mkdirSync(join(unreadable, ".git"));
    const item = blocked(unreconciled);
    const lockedRead = async (id: WorkItem["id"]): Promise<never> => {
      throw new LockedReadFailed(id);
    };
    const { released, saves, blocks, faults, containment } = run([item], false, notExercised("recordMergeCommit"), unreadable, undefined, 0, undefined, lockedRead);

    expect(await released).toBe(0);
    expect(saves).toEqual([]);
    expect(faults()).toBe(0);
    expect(blocks).toEqual([]);
    expect(containment.recorded.get(`parked-exits/${PROJECT}`)).toMatchObject({ faults: 1, error: expect.stringContaining(`the row of task ${item.id} could not be read under its lock`) });
  });

  test("a refused workspace path: the project halts at once, nothing counted, no retry can clear it", async () => {
    const outside = mkdtempSync(join("/var/tmp", "ashara-parked-outside-"));
    repos.push(outside);
    const { released, saves, blocks, faults } = run([blocked(unreconciled)], false, notExercised("recordMergeCommit"), outside);

    expect(await released).toBe(0);
    expect(saves).toEqual([]);
    expect(faults()).toBe(0);
    expect(blocks).toEqual([{ projectId: PROJECT, cause: expect.objectContaining({ category: "fault", errorClass: "OrphanUnreconciled", reason: expect.stringContaining("InvalidTargetProjectPath") }) }]);
  });
});

describe("a task held for the client's answer: its question is posted from the hold, and its project waits on the client, never gives it up", () => {
  const held: StoredBlockedReason = {
    source: "awaiting_client",
    waits: 1,
    questionId: "6f1c3c1e-8a52-4d43-9d7a-2b2f3e0e9a11",
    question: "Which command should start the product?",
    assumption: "The product starts as the tender describes it.",
    reason: "the tender contradicts itself",
  };

  test("a hold whose question is not on record (a crash after the hold was written) has it posted under the hold's id, once", async () => {
    const item = blocked(held);
    const first = run([item], false, notExercised("recordMergeCommit"), null, { askable: true, answered: false });
    expect(await first.released).toBe(0);
    expect(first.asked).toEqual([held.questionId]);
    expect(first.saves).toEqual([]);
  });

  test("its answer read, the task goes back to Pending, the count of waits carried", async () => {
    const item = blocked(held);
    const { released, saves, published } = run([item], false, notExercised("recordMergeCommit"), null, { askable: true, answered: true });
    expect(await released).toBe(1);
    expect(saves).toEqual([{ id: item.id, prev: "Blocked", status: "Pending", reason: expect.objectContaining({ source: "client_answered", waits: 1, questionId: held.questionId }) }]);
    expect(published.map((e) => e.eventType)).toEqual(["work_item.client_answered"]);
  });

  test("its answer read with its merge on main: recorded and Completed, never back to Pending", async () => {
    const item = blocked(held);
    const main = repoWith(`merge: task ${item.id}`);
    const records: string[] = [];
    const { released, saves } = run([item], false, async (id, commit) => void records.push(`${id}:${commit}`), main.path, { askable: true, answered: true });
    expect(await released).toBe(1);
    expect(records).toEqual([`${item.id}:${main.head}`]);
    expect(saves).toEqual([{ id: item.id, prev: "Blocked", status: "Completed", reason: undefined }]);
  });

  test("its answer read with main unreadable: it stays Blocked, never resumed blind, and no client_wait halt is raised for it", async () => {
    const unreadable = mkdtempSync(join(tmpdir(), "ashara-parked-"));
    repos.push(unreadable);
    mkdirSync(join(unreadable, ".git"));
    const { released, saves, blocks, faults } = run([blocked(held)], false, notExercised("recordMergeCommit"), unreadable, { askable: true, answered: true });
    expect(await released).toBe(0);
    expect(saves).toEqual([]);
    expect(blocks).toEqual([]);
    expect(faults()).toBe(1);
  });

  test("its answer read with main unread while the owner abandons it during the read: neither counted on its fault budget nor its project halted", async () => {
    const unreadable = mkdtempSync(join(tmpdir(), "ashara-parked-"));
    repos.push(unreadable);
    mkdirSync(join(unreadable, ".git"));
    const items = [blocked(held)];
    const abandon = (): void => void items.splice(0, 1, ...items.map((each) => ({ ...each, status: "Abandoned" as const })));
    const { released, saves, blocks, charged, faults } = run(items, false, notExercised("recordMergeCommit"), unreadable, { askable: true, answered: true }, 3, abandon);
    expect(await released).toBe(0);
    expect(charged).toEqual([]);
    expect(saves).toEqual([]);
    expect(blocks).toEqual([]);
    expect(faults()).toBe(3);
  });

  test("unanswered once no other work of the project could proceed, the project halts on client_wait and the task is neither given up nor moved", async () => {
    const item = blocked(held);
    const { released, saves, published, blocks } = run([item], false, notExercised("recordMergeCommit"), null, { askable: true, answered: false });
    expect(await released).toBe(0);
    expect(saves).toEqual([]);
    expect(published).toEqual([]);
    expect(blocks).toEqual([
      { projectId: PROJECT, cause: { category: "client_wait", errorClass: "ClientDecisionAwaited", reason: expect.stringContaining(held.question) } },
    ]);
  });

  test("unanswered while other work of the project could still proceed, it holds and the project works on", async () => {
    const pending: WorkItem = { ...blocked(undefined), status: "Pending", blockedReason: undefined };
    const { released, saves, blocks } = run([blocked(held), pending], false, notExercised("recordMergeCommit"), null, { askable: true, answered: false });
    expect(await released).toBe(0);
    expect(saves).toEqual([]);
    expect(blocks).toEqual([]);
  });

  test("a question that cannot be put to the client gives the task up under its own cause, never as a failed attempt", async () => {
    const item = blocked(held);
    const { released, saves, blocks } = run([item], false, notExercised("recordMergeCommit"), null, { askable: false, answered: false });
    expect(await released).toBe(1);
    expect(saves).toEqual([
      { id: item.id, prev: "Blocked", status: "Abandoned", reason: expect.objectContaining({ source: "prerequisite_unresolved", why: "unaskable", waits: 1 }) },
    ]);
    expect(blocks).toEqual([]);
  });
});

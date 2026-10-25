import type { EventStoreRepository } from "@ashara/db";
import type { DomainEvent, Logger, ProjectId, StepContainment } from "@ashara/shared";
import { containEach } from "@ashara/shared";
import type { MergeKind, StoredBlockedReason } from "./work-item-language/blocked-reason.js";
import { blockedExitOf } from "./work-item-language/blocked-reason.js";
import { InvalidStatusTransition } from "./work-item-language/transitions.js";
import { OPEN_WORK_ITEM_STATUSES } from "./work-item-language/work-item-status.js";
import { WorkItemRowCorrupt } from "./work-item-language/work-item-row.js";
import type { WorkItem, WorkItemRepository } from "./domain/index.js";
import { giveUpUnaskable, giveUpWorkItem, PlanningService, takeEvents } from "./domain/index.js";
import { releaseMergedTask } from "./orphan-merge.js";
import type { TargetPathSource } from "./orphan-merge.js";
import type { MainHoldsNoMerge } from "./requeue-on-main.js";
import { chargeUnreadMain, readMainForMerge, returnToPending } from "./requeue-on-main.js";
import { MERGE_RECORD_BACKOFF_MS } from "./execution/merge-record.js";
import { clientWaitCause } from "./project-halt.js";
import type { ProjectBlockCause } from "./project-halt.js";
import type { ClientQuestions } from "./execution/dispatch-run-deps.js";

type HeldReason = Extract<StoredBlockedReason, { source: "awaiting_client" }>;

// The exits of Blocked work items (no work item waits on a person), each taken by the loop every
// cycle: a merged task whose merge record was not written has the record written again, then
// Completed; a crash orphan the startup reconciler could not settle has main read again, then
// Completed with its merge or back to Pending; an infrastructure block from a legacy row has main
// read, then Completed with its merge or back to Pending; a task a client's correction holds waits
// for the correction's plan revision, which supersedes it; a task held for the client's answer has
// its question posted if it is not on record yet, and once the answer is read has main read, then
// goes back to Pending, its project halting on client_wait while no other work of it could proceed;
// any other block (from a legacy row, or with no reason) has no cause that clears by itself, so the
// task is given up and its plan repaired. Shared blockedExitOf decides which is which. Every exit to
// Pending reads main first (readMainForMerge): a task whose dispatch merged is never dispatched again.

interface ParkedExitDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  /**
   * `get` names the target whose main a task's merge is read from before it leaves Blocked; `block`
   * halts a project whose only work left waits on the client's answers.
   */
  readonly projects: {
    listActiveIds(): Promise<ProjectId[]>;
    block(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
  } & TargetPathSource;
  /** Where a held task's question is posted, and whether the client's answer to it has been read. */
  readonly clientQuestions: ClientQuestions;
  /** The workdir base every target workspace lies in (assertValidTargetProjectPath). */
  readonly workdirBase: string;
  /** Each project's own fault is contained to it (containEach). */
  readonly containment: StepContainment;
  readonly logger: Logger;
}

/**
 * Takes the exit of every Blocked task of an active project, publishing its events: a
 * merge_unrecorded task is Completed once its merge record is written, an infrastructure block is
 * Completed with its merge on main or released to Pending, a correction_pending task stays for its revision, and any other block is given up. A project whose Blocked rows do not parse
 * is skipped here: the gate blocks it this same cycle. Any other failure is that project's,
 * contained to it (containEach). Returns how many tasks left Blocked.
 */
export async function releaseClearedBlocks(deps: ParkedExitDeps): Promise<number> {
  const projects = await deps.projects.listActiveIds();
  const released = await containEach(deps.containment, "parked-exits", projects, (projectId) => ({ id: projectId, projectId }), (projectId) => releaseProject(deps, projectId));
  let total = 0;
  for (const outcome of released) if (typeof outcome === "number") total += outcome;
  return total;
}

/** The exits of one project's Blocked tasks; returns how many left Blocked. */
async function releaseProject(deps: ParkedExitDeps, projectId: ProjectId): Promise<number> {
  let blocked: WorkItem[];
  try {
    blocked = await deps.workItemRepo.findByProjectAndStatus(projectId, "Blocked");
  } catch (err) {
    if (!(err instanceof WorkItemRowCorrupt)) throw err;
    deps.logger.warn("delivery.blocked-rows-corrupt", `project ${projectId}: its Blocked tasks are not re-checked`, { projectId }, err);
    // eslint-disable-next-line no-restricted-syntax -- policy default: the pass released no task, which is what it returns; the record above names why
    return 0;
  }
  let released = 0;
  const stillHeld: HeldReason[] = [];
  for (const item of blocked) {
    const exit = blockedExitOf(item.blockedReason);
    let left: boolean;
    switch (exit.kind) {
      case "merge-recorded":
        left = await completeRecordedMerge(deps, item, exit.mergeCommit, exit.mergeKind);
        break;
      case "give-up":
        left = await giveUp(deps, item);
        break;
      case "read-main":
      case "requeue":
        left = await settleOnMain(deps, item);
        break;
      case "await-revision":
        // Held by a client's correction: the revision the replanning step writes for it supersedes it.
        left = false;
        break;
      case "await-answer": {
        const answer = await awaitAnswer(deps, item, exit.held);
        left = answer === "left";
        if (answer === "held") stillHeld.push(exit.held);
        break;
      }
    }
    if (left) released++;
  }
  await haltOnClientWait(deps, projectId, stillHeld);
  return released;
}

/**
 * A merged task whose merge record could not be written: the record is written again, and once
 * it holds the worktree and branch no dispatch released are released and the task is Completed
 * (never Pending: its work is on main). A write that fails leaves it Blocked for the next cycle.
 */
async function completeRecordedMerge(deps: ParkedExitDeps, item: WorkItem, mergeCommit: string, mergeKind: MergeKind | null): Promise<boolean> {
  try {
    await deps.workItemRepo.recordMergeCommit(item.id, mergeCommit, mergeKind);
  } catch (err) {
    deps.logger.warn("delivery.merge-record-failed", `the record of merge ${mergeCommit} still cannot be written; it stays Blocked`, { taskId: item.id, mergeCommit }, err);
    // eslint-disable-next-line no-restricted-syntax -- policy default: false is the fail-closed answer, the task stays Blocked; the record above names why
    return false;
  }
  await releaseMergedTask(deps.projects, deps.workdirBase, item, mergeKind, deps.logger);
  let events: DomainEvent[];
  try {
    events = await PlanningService.completeRecordedMerge(deps.workItemRepo, item);
  } catch (err) {
    if (!(err instanceof InvalidStatusTransition)) throw err;
    deps.logger.warn("delivery.transition-rejected", `merge ${mergeCommit} recorded, but not completed: it changed concurrently (${err.from} -> ${err.to})`, {
      taskId: item.id,
      from: err.from,
      to: err.to,
    }, err);
    // eslint-disable-next-line no-restricted-syntax -- policy default: false is the fail-closed answer, the task is not completed; the record above names why
    return false;
  }
  deps.logger.info("delivery.parked-merge-completed", `merge ${mergeCommit} recorded; Completed`, { taskId: item.id, mergeCommit });
  await publishAll(deps, item.id, events);
  return true;
}

/**
 * A blocked task whose exit is Pending: a crash orphan the startup reconciler could not settle
 * (orphan_unreconciled), or an infrastructure block from a legacy row. Main is read for the task's
 * merge. Found, it is recorded and the task Completed; none, the task goes back to Pending, now that
 * main says nothing of it was merged. Main unreadable leaves it Blocked for the next cycle, never
 * requeued blind, under the one policy for an unread main (chargeUnreadMain), charged only while it
 * is still Blocked under the charge's row lock.
 */
async function settleOnMain(deps: ParkedExitDeps, item: WorkItem): Promise<boolean> {
  const read = await readMainForMerge(deps, item, MERGE_RECORD_BACKOFF_MS);
  if (read.kind === "unread") {
    await chargeUnreadMain(deps, item, "read main for the task's merge before it leaves Blocked", read);
    return false;
  }
  if (read.kind === "merged") return completeRecordedMerge(deps, item, read.mergeCommit, "merged");
  return release(deps, item, read.absent);
}

/**
 * A task held for the client's answer to its question: the question is posted under the id the hold
 * chose, unless it is on record already (a hold written before a crash is posted here, from the next
 * cycle on); once the answer is read main is read for the task's merge, and the task goes back to
 * Pending, its next attempt reading the answer in the vision (Completed instead with a merge found;
 * left Blocked for the next cycle while main cannot be read). A question that cannot be put to the
 * client gives the task up, its plan repaired, never counted as a failed attempt. Returns whether it
 * left Blocked; `held`, it is one the project may halt on (haltOnClientWait).
 */
async function awaitAnswer(deps: ParkedExitDeps, item: WorkItem, held: HeldReason): Promise<"left" | "held" | "main-unread"> {
  const { questionId } = held;
  const posting = await deps.clientQuestions.ask({
    questionId,
    projectId: item.projectId,
    taskId: item.id,
    taskTitle: item.title,
    question: held.question,
    assumption: held.assumption,
    underpins: guaranteesOf(item),
  });
  if (posting.kind === "not-askable") {
    giveUpUnaskable(item, posting.why);
    if (!(await saveBlocked(deps, item, "not given up on a question that cannot be asked"))) return "held";
    deps.logger.info("delivery.task-given-up", `question ${questionId} cannot be put to the client (${posting.why}); given up, its plan is repaired`, {
      taskId: item.id,
      source: "prerequisite_unresolved",
      questionId,
    });
    await publishAll(deps, item.id, takeEvents(item));
    return "left";
  }
  if (posting.kind === "posted") {
    deps.logger.info("delivery.client-question-posted", `question ${questionId} is posted to the client as assumption ${posting.assumptionKey} (vision v${posting.visionVersion})`, {
      taskId: item.id,
      questionId,
      assumptionKey: posting.assumptionKey,
      visionVersion: posting.visionVersion,
    });
  }
  if (!(await deps.clientQuestions.answered(questionId))) return "held";
  const read = await readMainForMerge(deps, item, MERGE_RECORD_BACKOFF_MS);
  if (read.kind === "unread") {
    await chargeUnreadMain(deps, item, `read main for the task's merge once the client's answer to question ${questionId} is read`, read);
    return "main-unread";
  }
  if (read.kind === "merged") return (await completeRecordedMerge(deps, item, read.mergeCommit, "merged")) ? "left" : "held";
  returnToPending(item, read.absent);
  if (!(await saveBlocked(deps, item, "not resumed on the client's answer"))) return "held";
  deps.logger.info("delivery.client-answered", `the client's answer to question ${questionId} is read; back to Pending`, { taskId: item.id, questionId });
  await publishAll(deps, item.id, takeEvents(item));
  return "left";
}

/** The guarantees a task delivers, by key: what a decision it waits on underpins. */
function guaranteesOf(item: WorkItem): string[] {
  const spec = item.taskSpec;
  if (spec === undefined || !("sources" in spec) || spec.sources === undefined) return [];
  return spec.sources.flatMap((source) => (source.type === "guarantee" ? [source.id] : []));
}

/**
 * Once no work of the project could proceed but on the client's answers to the questions `held`
 * tasks wait on, the wait cannot end by itself: the project halts on client_wait, which tells the
 * client and the operator, until the client's answer to one of them is read (client-wait-halts.ts).
 * No task is given up and no plan repaired for it. Unanswered while other work could proceed, the
 * tasks stay held and the project works on.
 */
async function haltOnClientWait(deps: ParkedExitDeps, projectId: ProjectId, held: readonly HeldReason[]): Promise<void> {
  if (held.length === 0 || !(await stalledOnClient(deps, projectId))) return;
  const questions = held.map((each) => `question ${each.questionId}: ${each.question}`).join("\n");
  const outcome = await deps.projects.block(
    projectId,
    clientWaitCause(`no work of the project can proceed until the client answers ${held.length === 1 ? "this question" : "one of these questions"}:\n${questions}`),
  );
  deps.logger.info(
    "delivery.client-wait-halt",
    outcome === "blocked" ? `halted until the client answers: ${held.map((each) => each.questionId).join(", ")}` : "already halted; its first cause stands",
    { projectId, questionIds: held.map((each) => each.questionId), outcome },
  );
}

/** Saves a task that was Blocked; false when it moved meanwhile, which is warned of. */
async function saveBlocked(deps: ParkedExitDeps, item: WorkItem, what: string): Promise<boolean> {
  try {
    await PlanningService.saveWorkItem(deps.workItemRepo, item, "Blocked");
  } catch (err) {
    if (!(err instanceof InvalidStatusTransition)) throw err;
    deps.logger.warn("delivery.transition-rejected", `${what}: it changed concurrently (${err.from} -> ${err.to})`, { taskId: item.id, from: err.from, to: err.to }, err);
    // eslint-disable-next-line no-restricted-syntax -- policy default: false is the fail-closed answer, the task is left where it moved; the record above names why
    return false;
  }
  return true;
}

/**
 * Whether no work of the project could proceed but the client's answers: no task is in progress or
 * Failed (whose recovery the failure router decides), no Blocked task but one held for an answer, and
 * every Pending task depends, directly or transitively, on one held for an answer.
 */
async function stalledOnClient(deps: ParkedExitDeps, projectId: ProjectId): Promise<boolean> {
  const tasks = (await deps.workItemRepo.listByProject(projectId)).filter((each) => each.level === "Task");
  const held = new Set(tasks.filter((each) => each.status === "Blocked" && each.blockedReason?.source === "awaiting_client").map((each) => each.id));
  // Open and neither Pending nor held: in progress, Failed, or Blocked on a cause that clears without the client.
  const others = tasks.filter((each) => !held.has(each.id) && OPEN_WORK_ITEM_STATUSES.includes(each.status));
  if (others.some((each) => each.status !== "Pending")) return false;
  const edges = await deps.workItemRepo.listDependenciesByProject(projectId);
  const waitsOnHeld = new Set<string>(held);
  for (let grew = true; grew; ) {
    grew = false;
    for (const { fromId, toId } of edges) {
      if (waitsOnHeld.has(toId) && !waitsOnHeld.has(fromId)) {
        waitsOnHeld.add(fromId);
        grew = true;
      }
    }
  }
  return tasks.every((each) => each.status !== "Pending" || waitsOnHeld.has(each.id));
}

async function publishAll(deps: ParkedExitDeps, taskId: WorkItem["id"], events: readonly DomainEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await deps.eventStore.publish(event);
    } catch (err) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the transition is committed before its events are published; domain_events is an operator audit log (GET /events is the bearer route) that no verdict, counter, charge or client text reads: each reads state written in the transition's own transaction, work_item_transitions for starts and reopens
      deps.logger.warn("delivery.event-publish-failed", `failed to publish ${event.eventType} (the transition is committed)`, {
        taskId,
        site: "parked-exits",
        eventType: event.eventType,
      }, err);
    }
  }
}

/**
 * A block with no exit that clears by itself: the task is given up with the cause it was blocked
 * for (a Blocked item with none is recorded as an orchestrator error, the state no writer should
 * have left), and its abandonment opens a plan repair.
 */
async function giveUp(deps: ParkedExitDeps, item: WorkItem): Promise<boolean> {
  const reason = item.blockedReason;
  const cause =
    reason === undefined || reason.source === "superseded"
      ? { source: "orchestrator_error" as const, reason: `Blocked with ${reason === undefined ? "no recorded reason" : "a superseded reason"}; given up` }
      : reason;
  giveUpWorkItem(item, cause);
  try {
    await PlanningService.saveWorkItem(deps.workItemRepo, item, "Blocked");
  } catch (err) {
    if (!(err instanceof InvalidStatusTransition)) throw err;
    deps.logger.warn("delivery.transition-rejected", `not given up, it changed concurrently (${err.from} -> ${err.to})`, { taskId: item.id, from: err.from, to: err.to }, err);
    // eslint-disable-next-line no-restricted-syntax -- policy default: false is the fail-closed answer, the task is not given up this pass; the record above names why
    return false;
  }
  deps.logger.info("delivery.task-given-up", `its ${cause.source} block has no exit that clears by itself; given up, its plan is repaired`, {
    taskId: item.id,
    source: cause.source,
  });
  await publishAll(deps, item.id, takeEvents(item));
  return true;
}

async function release(deps: ParkedExitDeps, item: WorkItem, absent: MainHoldsNoMerge): Promise<boolean> {
  const source = item.blockedReason?.source ?? "none";
  returnToPending(item, absent);
  try {
    await PlanningService.saveWorkItem(deps.workItemRepo, item, "Blocked");
  } catch (err) {
    if (!(err instanceof InvalidStatusTransition)) throw err;
    deps.logger.warn("delivery.transition-rejected", `not released, it changed concurrently (${err.from} -> ${err.to})`, { taskId: item.id, from: err.from, to: err.to }, err);
    // eslint-disable-next-line no-restricted-syntax -- policy default: false is the fail-closed answer, the task is not released; the record above names why
    return false;
  }
  deps.logger.info("delivery.block-cleared", `its ${source} block cleared; back to Pending`, { taskId: item.id, source });
  await publishAll(deps, item.id, takeEvents(item));
  return true;
}

import { createDomainEvent } from "@ashara/shared";
import type { WorkItemId } from "@ashara/shared";
import type { StoredBlockedReason } from "../work-item-language/blocked-reason.js";
import { OPEN_WORK_ITEM_STATUSES } from "../work-item-language/work-item-status.js";
import { InvalidStatusTransition, canTransitionTo } from "../work-item-language/transitions.js";
import type { WorkItem } from "./work-item.js";
import { giveUpWorkItem } from "./work-item.js";

/**
 * How many waits in a row on an owner outside the task (another task's work, the client's decision)
 * one task may take before it is given up and its plan repaired (a design call, overrulable). Each
 * wait gives its dispatch back, so without this bound a task that blocks again after every wait
 * would never spend its attempts and never end.
 */
const OWNER_WAIT_BOUND = 3;

/** What a blocked finish needs of another task's work, as the implementer named it. */
interface WorkNeed {
  /** The public interface entries it needs delivered first. */
  readonly interfaceEntries: readonly [string, ...string[]];
  /** The implementer's own statement of what is missing, with Z0's record of the attempt. */
  readonly reason: string;
}

type WorkWaitExit =
  /** The task is back at Pending and waits on `on`, each a dependency the caller writes with it. */
  | { readonly kind: "waiting"; readonly on: readonly [WorkItemId, ...WorkItemId[]]; readonly waits: number }
  /** The task is given up with a prerequisite_unresolved reason: no open task delivers what it needs. */
  | { readonly kind: "unplanned" }
  /** The task is given up with a prerequisite_unresolved reason: past the bound of waits. */
  | { readonly kind: "bound"; readonly bound: number };

/** The waits on an owner outside the task taken in a row so far, as its stored reason carries them. */
function ownerWaitsOf(item: WorkItem): number {
  const reason = item.blockedReason;
  if (reason?.source === "awaiting_work" || reason?.source === "client_answered") return reason.waits;
  return 0;
}

/** The product's public interface as the implementer's brief showed it: each entry by its key, with its text. */
export type InterfaceTable = ReadonlyArray<{ readonly key: string; readonly text: string }>;

/** The entries a blocked finish named, each resolved to one key of the interface; or why some could not be. */
export type ResolvedEntries =
  | { readonly kind: "resolved"; readonly keys: readonly [string, ...string[]] }
  | { readonly kind: "unresolved"; readonly problems: readonly [string, ...string[]] };

type ResolvedName = { readonly key: string } | { readonly problem: string };

function resolveName(raw: string, table: InterfaceTable): ResolvedName {
  const name = raw.trim();
  const matches = [...new Set(table.filter((entry) => entry.key === name || entry.text.trim() === name).map((entry) => entry.key))];
  const [only, ...more] = matches;
  if (only === undefined) {
    return {
      problem:
        table.length === 0
          ? `"${name}" names no interface entry: the vision records no public interface`
          : `"${name}" is the key or the text of no interface entry (${table.map((entry) => entry.key).join(", ")})`,
    };
  }
  if (more.length > 0) return { problem: `"${name}" could be any of the interface entries ${matches.join(", ")}: name one by its key` };
  return { key: only };
}

/**
 * Each entry a blocked finish named, resolved against the interface its brief showed: by its key, or
 * by an entry's exact text. A name that is neither, or that is the key or text of more than one entry,
 * names no entry: what the finish waits on is then unknown, never guessed.
 */
export function resolveInterfaceEntries(named: readonly [string, ...string[]], table: InterfaceTable): ResolvedEntries {
  const [head, ...tail] = named;
  const first = resolveName(head, table);
  const rest = tail.map((name) => resolveName(name, table));
  const problems = [first, ...rest].flatMap((each) => ("problem" in each ? [each.problem] : []));
  const [firstProblem, ...otherProblems] = problems;
  if (firstProblem !== undefined) return { kind: "unresolved", problems: [firstProblem, ...otherProblems] };
  if (!("key" in first)) return { kind: "unresolved", problems: [first.problem] };
  const others = rest.flatMap((each) => ("key" in each && each.key !== first.key ? [each.key] : []));
  return { kind: "resolved", keys: [first.key, ...new Set(others)] };
}

/** Who delivers what a blocked finish named: the open tasks that build its resolved entries, or why the names resolve to none. */
export type DeliveringTasks =
  | { readonly kind: "resolved"; readonly keys: readonly [string, ...string[]]; readonly owners: WorkItemId[] }
  | Extract<ResolvedEntries, { kind: "unresolved" }>;

/**
 * The open implementation tasks of `items` that deliver one of the entries `named`, resolved against
 * `table` (resolveInterfaceEntries): each cites a guarantee observed through the entry. The task itself
 * is never one, nor a task that already depends on it, directly or transitively (`dependsOn`): waiting
 * on that one would close a cycle no task leaves.
 */
export function deliveringTasks(
  task: WorkItem,
  named: readonly [string, ...string[]],
  table: InterfaceTable,
  items: readonly WorkItem[],
  edges: ReadonlyArray<{ readonly fromId: WorkItemId; readonly toId: WorkItemId }>,
): DeliveringTasks {
  const resolved = resolveInterfaceEntries(named, table);
  if (resolved.kind === "unresolved") return resolved;
  const wanted = new Set<string>(resolved.keys);
  const dependents = dependentsOf(task.id, edges);
  const owners = items
    .filter(
      (item) =>
        item.id !== task.id &&
        item.level === "Task" &&
        item.taskSpec?.origin === "decomposition" &&
        OPEN_WORK_ITEM_STATUSES.includes(item.status) &&
        !dependents.has(item.id) &&
        item.taskSpec.sources?.some((source) => source.type === "guarantee" && source.interface.some((entry) => wanted.has(entry))) === true,
    )
    .map((item) => item.id);
  return { kind: "resolved", keys: resolved.keys, owners };
}

/** Every item that depends on `id`, directly or transitively. */
function dependentsOf(id: WorkItemId, edges: ReadonlyArray<{ readonly fromId: WorkItemId; readonly toId: WorkItemId }>): Set<WorkItemId> {
  const found = new Set<WorkItemId>();
  const frontier: WorkItemId[] = [id];
  for (let next = frontier.pop(); next !== undefined; next = frontier.pop()) {
    for (const edge of edges) {
      if (edge.toId === next && !found.has(edge.fromId)) {
        found.add(edge.fromId);
        frontier.push(edge.fromId);
      }
    }
  }
  return found;
}

function requireInProgress(task: WorkItem, to: "Pending" | "Blocked" | "Abandoned"): void {
  if (task.status !== "InProgress" || !canTransitionTo(task.status, to)) throw new InvalidStatusTransition(task.id, task.status, to);
}

/**
 * The exit of an InProgress task whose implementer finished blocked on another task's work. Not the
 * task's failure: within the bound it returns to Pending waiting on `owners`, the open tasks that
 * deliver what it needs, and the caller writes its dependency on each with it, its dispatch given
 * back. With no such task the need is a gap in the plan, and the task is given up so its plan is
 * repaired; past the bound of waits it is given up too. Neither give-up counts a failed attempt.
 */
export function awaitWork(task: WorkItem, need: WorkNeed, owners: readonly WorkItemId[]): WorkWaitExit {
  const waits = ownerWaitsOf(task);
  const entries = need.interfaceEntries.join(", ");
  if (waits >= OWNER_WAIT_BOUND) {
    requireInProgress(task, "Abandoned");
    giveUpWorkItem(task, {
      source: "prerequisite_unresolved",
      why: "bound",
      waits,
      reason: `blocked again on work it needs (${entries}) after ${waits} wait(s) in a row, the bound of ${OWNER_WAIT_BOUND}:\n${need.reason}`,
    });
    return { kind: "bound", bound: OWNER_WAIT_BOUND };
  }
  const [first, ...rest] = owners;
  if (first === undefined) {
    requireInProgress(task, "Abandoned");
    giveUpWorkItem(task, {
      source: "prerequisite_unresolved",
      why: "unplanned",
      waits,
      reason: `blocked on work it needs (${entries}), and no open task of the plan delivers it: a gap in the plan:\n${need.reason}`,
    });
    return { kind: "unplanned" };
  }
  requireInProgress(task, "Pending");
  const on: [WorkItemId, ...WorkItemId[]] = [first, ...rest];
  task.status = "Pending";
  task.blockedReason = {
    source: "awaiting_work",
    waits: waits + 1,
    interfaceEntries: [...need.interfaceEntries],
    on: [...on],
    reason: `waits for ${on.join(", ")}, which deliver ${entries}:\n${need.reason}`,
  };
  task.updatedAt = new Date();
  task.events.push(
    createDomainEvent("work_item.awaiting_work", "delivery", {
      work_item_id: task.id,
      level: task.level,
      interface_entries: [...need.interfaceEntries],
      on: [...on],
      waits: waits + 1,
    }),
  );
  return { kind: "waiting", on, waits: waits + 1 };
}

/** Whether a task blocked on the client's decision is past the bound of waits; given up if so, before any question is posted. */
export function clientWaitPastBound(task: WorkItem, reason: string): boolean {
  const waits = ownerWaitsOf(task);
  if (waits < OWNER_WAIT_BOUND) return false;
  requireInProgress(task, "Abandoned");
  giveUpWorkItem(task, {
    source: "prerequisite_unresolved",
    why: "bound",
    waits,
    reason: `blocked again on a decision of the client's after ${waits} wait(s) in a row, the bound of ${OWNER_WAIT_BOUND}; no question is posted:\n${reason}`,
  });
  return true;
}

/**
 * The question a task held for the client waits on. `questionId` is chosen before the question is
 * posted and is the id it is posted under, so the hold is written first and the post, which the loop
 * repeats until it is on record (parked-exits.ts), can never leave a question no task waits on.
 */
export interface HeldQuestion {
  readonly questionId: string;
  /** The question as the task's implementer wrote it for the client. */
  readonly question: string;
  /** What the tender and the vision say now, which stands until the client answers. */
  readonly assumption: string;
  readonly reason: string;
}

/**
 * Holds an InProgress task for the client's answer to its question (`held.questionId`): it is
 * Blocked, never dispatched, until the answer is read (resumeOnAnswer), its dispatch given back.
 */
export function holdForClient(task: WorkItem, held: HeldQuestion): void {
  requireInProgress(task, "Blocked");
  const waits = ownerWaitsOf(task) + 1;
  task.status = "Blocked";
  task.blockedReason = {
    source: "awaiting_client",
    waits,
    questionId: held.questionId,
    question: held.question,
    assumption: held.assumption,
    reason: `waits for the client's answer to question ${held.questionId}:\n${held.reason}`,
  };
  task.updatedAt = new Date();
  task.events.push(
    createDomainEvent("work_item.awaiting_client", "delivery", {
      work_item_id: task.id,
      level: task.level,
      question_id: held.questionId,
      waits,
    }),
  );
}

function requireHeld(task: WorkItem, to: "Pending" | "Abandoned"): Extract<StoredBlockedReason, { source: "awaiting_client" }> {
  const reason = task.blockedReason;
  if (task.status !== "Blocked" || reason?.source !== "awaiting_client" || !canTransitionTo(task.status, to)) {
    throw new InvalidStatusTransition(task.id, task.status, to);
  }
  return reason;
}

/**
 * The question a held task waits on could not be put to the client (`why`): the task cannot wait for
 * an answer that cannot come, so it is given up and its plan repaired, never counted as a failed attempt.
 */
export function giveUpUnaskable(task: WorkItem, why: string): void {
  const reason = requireHeld(task, "Abandoned");
  giveUpWorkItem(task, {
    source: "prerequisite_unresolved",
    why: "unaskable",
    waits: reason.waits,
    reason: `blocked on a decision of the client's, but the question could not be put to the client (${why}):\n${reason.question}`,
  });
}

/**
 * Returns a task held for the client's answer to Pending once the answer is read: its next attempt
 * reads the answer in the vision. The count of waits is carried, so the next wait adds to it.
 */
export function resumeOnAnswer(task: WorkItem): void {
  const reason = requireHeld(task, "Pending");
  task.status = "Pending";
  task.blockedReason = {
    source: "client_answered",
    waits: reason.waits,
    questionId: reason.questionId,
    reason: `the client answered question ${reason.questionId}; the task goes on with the answer`,
  };
  task.updatedAt = new Date();
  task.events.push(
    createDomainEvent("work_item.client_answered", "delivery", {
      work_item_id: task.id,
      level: task.level,
      question_id: reason.questionId,
    }),
  );
}


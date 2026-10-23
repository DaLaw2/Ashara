import { isGoalTask } from "./predicates.js";
import type { PlanningVision } from "./acl/engagement-acl.js";
import { itemsToCheck } from "./decomposition-types.js";
import type { LayoutPlanning, VisionItem } from "./decomposition-types.js";
import type { WorkItem } from "./domain/index.js";
import type { PlannedItem, ProjectAwaitingReplan, RevisionCause } from "./replan-port.js";
import { affectedKeys } from "./revision-cause.js";
import { IDLE_OPEN_WORK_ITEM_STATUSES, SETTLED_WORK_ITEM_STATUSES } from "./work-item-language/work-item-status.js";
import { workOnMain } from "./work-item-language/work-on-main.js";

/** What a revision replaces and plans again. */
export interface RevisionScope {
  /** A task in progress the revision waits for; null when it waits for none. */
  readonly waitsOn: PlannedItem | null;
  /** The open tasks and Epics it supersedes. */
  readonly replaced: readonly PlannedItem[];
  /** The vision items it plans again, as the current vision states them. */
  readonly planned: readonly VisionItem[];
  /** Open tasks it keeps that waited on a review task it supersedes: each waits on the revision's own review instead. */
  readonly regated: readonly RegatedTask[];
}

/** A kept task moved off a superseded review task onto the revision's own review. */
interface RegatedTask {
  readonly taskId: string;
  /** The superseded review task it waited on. */
  readonly review: string;
  /** Its own check tasks, kept: the revision's review reads their suites with its own. */
  readonly checkTasks: readonly string[];
}

function isTask(planned: PlannedItem): boolean {
  return planned.item.level === "Task";
}

/** A work item read as isGoalTask reads its row: the level and the task_spec.origin, null where none is recorded. */
export function goalTask(item: WorkItem): boolean {
  return isGoalTask({ level: item.level, origin: item.taskSpec?.origin ?? null });
}

export function isEnvironmentTask(item: WorkItem): boolean {
  return item.workKind === "environment" || item.taskSpec?.origin === "sprint0";
}

/**
 * The product layout a revision builds on, or a new one when no scaffold
 * completed (an open one is superseded with the rest). Built on, its taskId is the layout's latest
 * merged state: of the latest completed product scaffold and every task with a merge on record that
 * completed after it, the last to complete. Never a task merged before the scaffold, whose commit
 * holds no product to build. A Completed task with a merge takes no later transition (only
 * a check task is reopened, and nothing of it is merged), so its updatedAt is when it completed.
 */
export function layoutOf(completed: readonly PlannedItem[]): LayoutPlanning {
  const scaffolds = completed.filter(({ item }) => item.taskSpec?.origin === "product-scaffold");
  const scaffold = scaffolds[scaffolds.length - 1];
  if (scaffold === undefined) return { kind: "new" };
  let latest = scaffold;
  for (const planned of completed) {
    if (planned.mergeCommit === null) continue;
    if (planned.item.updatedAt.getTime() > latest.item.updatedAt.getTime()) latest = planned;
  }
  return { kind: "existing", taskId: latest.item.id };
}

/**
 * The vision items the stored checks of a completed goal task (isGoalTask) decide, so a revision
 * need not give them a task again. What the task cites is never read here: an item it cites that no
 * stored check decides, a check stored before decides was recorded or a task completed with no
 * stored checks, is planned again. A key a correction the revision answers affects is never among
 * them: every stored check was written against the contract before that correction, and a key's text
 * can stand unchanged while what it rests on changed (an interface entry it is observed at, an
 * exclusion), so a check deciding it decides the old contract, not the corrected one.
 */
export function checkedByDone(completed: readonly PlannedItem[], cause: RevisionCause): VisionItem[] {
  const affected = new Set(cause.kind === "client-change" ? affectedKeys(cause.changes) : []);
  return completed.flatMap(({ item, decided }) => (goalTask(item) ? decided.filter((done) => !affected.has(done.id)) : []));
}

/**
 * Open, not in progress and not on main: work a revision may supersede, since an attempt in progress
 * is waited on instead, and merged work (workOnMain) is kept: a correction citing its key plans that
 * key again beside it.
 */
function isSupersedable(item: WorkItem): boolean {
  return IDLE_OPEN_WORK_ITEM_STATUSES.includes(item.status) && !workOnMain(item);
}

/** The project's tasks whose work is on main (workOnMain): the completed work a revision keeps and builds on. */
export function mergedTasks(items: readonly PlannedItem[]): PlannedItem[] {
  return items.filter(isTask).filter(({ item }) => workOnMain(item));
}

/** Not settled: an Epic a revision may still close or keep. */
function isUnsettled(item: WorkItem): boolean {
  return !SETTLED_WORK_ITEM_STATUSES.includes(item.status);
}

/** The vision keys a task cites in its task_spec's sources; none when its spec records no sources. */
function citedKeys(item: WorkItem): string[] {
  const sources = item.taskSpec?.sources;
  return sources === undefined ? [] : sources.map((source) => source.id);
}

/**
 * A repair's scope: the whole plan. It waits for every task in progress, supersedes every open task
 * and every open Epic (the revision writes its own), and plans the whole current vision again.
 */
export function wholePlanScope(project: ProjectAwaitingReplan, vision: PlanningVision): RevisionScope {
  const tasks = project.items.filter(isTask);
  const openEpics = project.items.filter(({ item }) => item.level === "Epic" && isUnsettled(item));
  return {
    waitsOn: tasks.find(({ item }) => item.status === "InProgress") ?? null,
    replaced: [...tasks.filter(({ item }) => isSupersedable(item)), ...openEpics],
    planned: vision.items,
    regated: [],
  };
}

/**
 * A correction's scope: only the work citing a key it affects. It waits for a task citing one that is
 * in progress and for no other; it supersedes the open tasks citing one, and every open task waiting
 * on those, directly or not, which would otherwise wait on work never done; and it plans again the
 * affected keys still in the vision and every item the work it supersedes, a review aside, cited. Two waits are not
 * passed on, since the work behind them is not changed: a superseded check task gates only the task it
 * checks, as dependency resolution reads it; and a task citing no affected key that waits on a
 * superseded review task is kept, moved to wait on the revision's own review (regated), unless the
 * revision plans nothing and so writes no review, when it is replaced with the review. Merged work
 * citing an affected key is kept (isSupersedable), a held task that finished its attempt and merged included: its key is not decided by the checks it merged with, which
 * decide the contract before the correction (checkedByDone), so it is planned again. An
 * open environment or layout task is replaced too while none is completed, since the revision then
 * plans its own. An open Epic left with no open task of its own is closed with the work it held,
 * since nothing would settle it.
 */
export function correctionScope(project: ProjectAwaitingReplan, affected: readonly string[], vision: PlanningVision, checked: readonly VisionItem[]): RevisionScope {
  const keys = new Set(affected);
  const tasks = project.items.filter(isTask);
  const byId = new Map<string, PlannedItem>(tasks.map((task) => [task.item.id, task]));
  const citing = tasks.filter(({ item }) => citedKeys(item).some((key) => keys.has(key)));
  const waitsOn = citing.find(({ item }) => item.status === "InProgress") ?? null;
  const openIds = new Set<string>(tasks.filter(({ item }) => isSupersedable(item)).map(({ item }) => item.id));
  // A dependent not read as a task is replaced: nothing shows it untouched.
  const citesAffected = (id: string) => {
    const task = byId.get(id);
    return task === undefined || citedKeys(task.item).some((key) => keys.has(key));
  };

  const closeOver = (seed: readonly PlannedItem[], reviewWaits: "regate" | "replace"): RevisionScope => {
    const replacedIds = new Set<string>(seed.map(({ item }) => item.id));
    const regatedOn = new Map<string, string>();
    const frontier = [...replacedIds];
    for (let next = frontier.pop(); next !== undefined; next = frontier.pop()) {
      const waitedOn = next;
      const gate = byId.get(waitedOn)?.item;
      const checksOnly = gate?.workKind === "check" ? (gate.taskSpec?.checksFor ?? null) : null;
      for (const edge of project.dependencies) {
        if (edge.toId !== waitedOn || replacedIds.has(edge.fromId) || !openIds.has(edge.fromId)) continue;
        if (checksOnly !== null && checksOnly !== edge.fromId) continue;
        if (reviewWaits === "regate" && gate?.taskSpec?.origin === "review" && !citesAffected(edge.fromId)) {
          regatedOn.set(edge.fromId, waitedOn);
          continue;
        }
        replacedIds.add(edge.fromId);
        frontier.push(edge.fromId);
      }
    }
    const replaced = tasks.filter(({ item }) => replacedIds.has(item.id));
    const closedEpics = project.items.filter(({ item }) => {
      if (item.level !== "Epic" || !isUnsettled(item)) return false;
      const children = tasks.filter((task) => task.item.parentId === item.id);
      return children.some((task) => replacedIds.has(task.item.id)) && children.every((task) => !isSupersedable(task.item) || replacedIds.has(task.item.id)) && !children.some((task) => task.item.status === "InProgress");
    });
    const regated = [...regatedOn].flatMap(([taskId, review]): RegatedTask[] =>
      replacedIds.has(taskId)
        ? []
        : [
            {
              taskId,
              review,
              checkTasks: tasks
                .filter(({ item }) => item.workKind === "check" && item.taskSpec?.checksFor === taskId && item.status !== "Abandoned" && !replacedIds.has(item.id))
                .map(({ item }) => item.id),
            },
          ],
    );
    // A review cites every item of its plan and builds none of them: the work it reviewed is planned by its own citations.
    const cited = new Set([...keys, ...replaced.filter(({ item }) => item.taskSpec?.origin !== "review").flatMap(({ item }) => citedKeys(item))]);
    return { waitsOn, replaced: [...replaced, ...closedEpics], planned: vision.items.filter((item) => cited.has(item.id)), regated };
  };

  const held = citing.filter(({ item }) => isSupersedable(item));
  const regating = closeOver(held, "regate");
  // A revision that plans nothing writes no review for a kept task to wait on: it is replaced instead.
  const reviewWaits = regating.regated.length > 0 && stillToCheck(regating.planned, checked).length === 0 ? "replace" : "regate";
  const scope = reviewWaits === "regate" ? regating : closeOver(held, reviewWaits);
  if (stillToCheck(scope.planned, checked).length === 0) return scope;
  // With no environment or layout merged, a revision that plans work plans its own (environmentOf,
  // layoutOf): the open one it would duplicate is replaced too, with the work waiting on it.
  const completed = mergedTasks(tasks);
  const setUpAgain = (setsUp: (item: WorkItem) => boolean) => !completed.some(({ item }) => setsUp(item));
  const isScaffold = (item: WorkItem) => item.taskSpec?.origin === "product-scaffold";
  const setsUpAgain = (item: WorkItem) => (isEnvironmentTask(item) && setUpAgain(isEnvironmentTask)) || (isScaffold(item) && setUpAgain(isScaffold));
  // One of them in progress is waited for, as a held task is: its result decides whether the revision sets up its own.
  const settingUp = tasks.find(({ item }) => item.status === "InProgress" && setsUpAgain(item)) ?? null;
  const duplicated = tasks.filter(({ item }) => isSupersedable(item) && setsUpAgain(item));
  const full = duplicated.length === 0 ? scope : closeOver([...held, ...duplicated], reviewWaits);
  return { ...full, waitsOn: waitsOn ?? settingUp };
}

/** The items of `planned` the plan must check that no completed goal task's stored checks already decide as the vision states them. */
export function stillToCheck(planned: readonly VisionItem[], checked: readonly VisionItem[]): VisionItem[] {
  return itemsToCheck(planned).filter((item) => !checked.some((done) => done.id === item.id && done.text === item.text));
}

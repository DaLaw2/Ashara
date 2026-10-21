import type { EventStoreRepository } from "@ashara/db";
import type { Logger } from "@ashara/shared";
import type { WorkItemStatus } from "../work-item-language/work-item-status.js";
import { InvalidStatusTransition } from "../work-item-language/transitions.js";
import type { WorkItem, WorkItemRepository } from "../domain/index.js";
import { PlanningService, takeEvents } from "../domain/index.js";
import { publishBestEffort } from "./audit-events.js";

/** What the reopen protocol reads, writes and reports through. */
export interface ReopenDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly logger: Logger;
}

/** The warning for an item left where it is: the status it was not moved to, and why. */
interface LeftAt {
  readonly message: string;
  readonly to: WorkItemStatus;
  readonly source?: string;
}

/** What follows a write an item moved under: the item left where it is, or another route taken instead. */
type Rejection = { readonly kind: "left"; readonly left: LeftAt } | { readonly kind: "instead"; readonly then: () => Promise<void> };

/**
 * The routed item's own write. `save` leaves its dispatch counted; every other kind gives the
 * dispatch back in the same write: alone, raising the context window it overflowed, or in one
 * transaction with `write`, whose `items` are published before the routed item.
 */
export type ItemWrite =
  | { readonly kind: "save" }
  | { readonly kind: "refund" }
  | { readonly kind: "refund-overflow"; readonly windowTokens: number }
  | { readonly kind: "refund-with"; readonly items: readonly WorkItem[]; readonly write: (tx: WorkItemRepository) => Promise<void> };

/** A write of another item that comes before the routed item's own, its events published once it commits. */
interface BeforeWrite {
  readonly write: () => Promise<void>;
  readonly published: readonly WorkItem[];
  /** What follows when an item moved under the write; null lets the rejection propagate. */
  readonly rejected: ((e: InvalidStatusTransition) => Rejection) | null;
}

/** What one exit of a route writes, and the line it reports once written. */
export interface ReopenPlan {
  readonly before: readonly BeforeWrite[];
  readonly write: ItemWrite;
  /** What follows when the item moved under its write; null lets the rejection propagate. */
  readonly rejected: ((e: InvalidStatusTransition) => Rejection) | null;
  /** Reports the exit; `dispatchCount` is the count after the refund, null when the dispatch stays counted. */
  readonly log: (dispatchCount: number | null) => void;
}

/** What a route supplies: its transition and what each of its exits writes and reports. */
export interface ReopenRoute<X> {
  readonly taskId: WorkItem["id"];
  /** The route's name on the events it publishes. */
  readonly site: string;
  /** The warning when the item is gone before it could be routed. */
  readonly vanished: string;
  /**
   * Moves the item by the route's domain function, after reading what that needs, and returns
   * the exit taken; throws InvalidStatusTransition when the item cannot take it.
   */
  readonly transition: (item: WorkItem) => X | Promise<X>;
  readonly transitionRejected: (e: InvalidStatusTransition) => LeftAt;
  readonly plan: (exit: X, item: WorkItem) => ReopenPlan;
}

type Answer<T> = { readonly kind: "done"; readonly value: T } | { readonly kind: "rejected"; readonly rejection: InvalidStatusTransition };

/** A step's value, or the InvalidStatusTransition it was refused with; any other throw propagates. */
async function answerOf<T>(step: () => T | Promise<T>): Promise<Answer<T>> {
  try {
    return { kind: "done", value: await step() };
  } catch (e) {
    if (!(e instanceof InvalidStatusTransition)) throw e;
    return { kind: "rejected", rejection: e };
  }
}

function warnLeft(deps: ReopenDeps, taskId: WorkItem["id"], left: LeftAt, e: InvalidStatusTransition): void {
  const fields = { taskId, from: e.from, to: left.to };
  deps.logger.warn("delivery.transition-rejected", left.message, left.source === undefined ? fields : { ...fields, source: left.source }, e);
}

async function settleRejection(
  deps: ReopenDeps,
  taskId: WorkItem["id"],
  rejected: ((e: InvalidStatusTransition) => Rejection) | null,
  e: InvalidStatusTransition,
): Promise<void> {
  if (rejected === null) throw e;
  const rejection = rejected(e);
  if (rejection.kind === "instead") {
    await rejection.then();
    return;
  }
  warnLeft(deps, taskId, rejection.left, e);
}

async function writeItem(repo: WorkItemRepository, item: WorkItem, previousStatus: WorkItemStatus, write: ItemWrite): Promise<number | null> {
  switch (write.kind) {
    case "save":
      await PlanningService.saveWorkItem(repo, item, previousStatus);
      return null;
    case "refund":
      return repo.saveRefunded(item, previousStatus);
    case "refund-overflow":
      return repo.saveRefundedOverflow(item, previousStatus, write.windowTokens);
    case "refund-with":
      return repo.withTransaction(async (tx) => {
        await write.write(tx);
        return tx.saveRefunded(item, previousStatus);
      });
  }
}

/**
 * The one protocol every route that reopens, requeues, parks or gives up a work item after a
 * dispatch follows: find the item, move it by the route's transition, write what comes before it,
 * write it (its dispatch kept or given back), publish the events of what was written, then report.
 * An item that is gone is warned of; one whose transition or write is refused because it moved is
 * left where it is, or taken by the route's other way, and nothing after that step runs.
 */
export async function reopen<X>(deps: ReopenDeps, route: ReopenRoute<X>): Promise<void> {
  const { taskId } = route;
  const item = await PlanningService.findWorkItem(deps.workItemRepo, taskId);
  if (!item) {
    deps.logger.warn("delivery.item-vanished", route.vanished, { taskId });
    return;
  }
  const previousStatus = item.status;
  const moved = await answerOf(() => route.transition(item));
  if (moved.kind === "rejected") {
    warnLeft(deps, taskId, route.transitionRejected(moved.rejection), moved.rejection);
    return;
  }
  const plan = route.plan(moved.value, item);
  for (const before of plan.before) {
    const done = await answerOf(before.write);
    if (done.kind === "rejected") {
      await settleRejection(deps, taskId, before.rejected, done.rejection);
      return;
    }
    for (const other of before.published) await publishBestEffort(deps, other.id, takeEvents(other), route.site);
  }
  const written = await answerOf(() => writeItem(deps.workItemRepo, item, previousStatus, plan.write));
  if (written.kind === "rejected") {
    await settleRejection(deps, taskId, plan.rejected, written.rejection);
    return;
  }
  if (plan.write.kind === "refund-with") {
    for (const other of plan.write.items) await publishBestEffort(deps, other.id, takeEvents(other), route.site);
  }
  await publishBestEffort(deps, taskId, takeEvents(item), route.site);
  plan.log(written.value);
}

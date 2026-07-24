import { and, eq, isNull, asc, sql } from "drizzle-orm";

import {
  parseWorkItemStatus,
  canTransitionTo,
  InvalidStatusTransition,
  WorkItemNotFound,
} from "@ashara/shared";

import type { DbHandle } from "../connection.js";
import { workItems, dependencies } from "../schema.js";

export class WorkItemRepository {
  constructor(private readonly db: DbHandle) {}

  /**
   * Runs `fn` inside a single database transaction (ADR-029). The callback
   * receives a transaction-scoped repository whose every write participates in
   * the same atomic unit — the batch of work items AND their dependency edges
   * commits or rolls back together, so a mid-loop crash cannot leave orphan
   * items whose missing edges make the Gate consider them prematurely eligible.
   */
  async withTransaction<T>(fn: (repo: WorkItemRepository) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new WorkItemRepository(tx)));
  }

  async create(item: typeof workItems.$inferInsert) {
    const [row] = await this.db.insert(workItems).values(item).returning();
    return row;
  }

  async findById(id: string) {
    const [row] = await this.db
      .select()
      .from(workItems)
      .where(eq(workItems.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByStatus(status: string) {
    return this.db
      .select()
      .from(workItems)
      .where(eq(workItems.status, status));
  }

  /**
   * Physical writer for the WorkItem state machine (ADR-029). `expectedPreviousStatus`
   * is the pre-image the caller believes the row holds; callers read it from the domain
   * object before mutating it. The write fails closed with InvalidStatusTransition when:
   *   - the requested transition is not permitted by canTransitionTo (the single guard),
   *     unless it is a same-status metadata write (from === to), which stays legal; or
   *   - the live row no longer holds the claimed pre-image (concurrent modification),
   *     detected by a conditional UPDATE that must affect exactly the targeted row.
   */
  async save(
    item: { id: string; status: string; blockedReason?: unknown; updatedAt: Date },
    expectedPreviousStatus: string,
  ) {
    const from = parseWorkItemStatus(expectedPreviousStatus);
    const to = parseWorkItemStatus(item.status);

    if (from !== to && !canTransitionTo(from, to)) {
      throw new InvalidStatusTransition(item.id, from, to);
    }

    const updated = await this.db
      .update(workItems)
      .set({
        status: item.status,
        // `undefined` means "caller cleared it" (e.g. unblock/replan) --
        // Drizzle's `.set()` drops `undefined` keys instead of writing SQL
        // NULL, so an unnormalized `undefined` would silently leave the
        // stale blockedReason in place. Normalize to `null` here, at the
        // single physical writer, so every caller's clear actually clears.
        blockedReason: item.blockedReason ?? null,
        updatedAt: item.updatedAt,
      })
      .where(and(eq(workItems.id, item.id), eq(workItems.status, expectedPreviousStatus)))
      .returning({ id: workItems.id });

    if (updated.length === 0) {
      const [row] = await this.db
        .select({ status: workItems.status })
        .from(workItems)
        .where(eq(workItems.id, item.id))
        .limit(1);
      if (!row) {
        throw new WorkItemNotFound(item.id);
      }
      throw new InvalidStatusTransition(item.id, parseWorkItemStatus(row.status), to);
    }
  }

  /**
   * Atomically bumps the dispatch counter (migration 018, r9f-t1). A single
   * `dispatch_count = dispatch_count + 1` UPDATE, independent of the status
   * pre-image guard in `save`, so it commits at the dispatch seam and survives a
   * crashed agent or discarded output. Returns the post-increment value.
   */
  async incrementDispatchCount(id: string): Promise<number> {
    const [row] = await this.db
      .update(workItems)
      .set({ dispatchCount: sql`${workItems.dispatchCount} + 1` })
      .where(eq(workItems.id, id))
      .returning({ dispatchCount: workItems.dispatchCount });
    if (!row) {
      throw new WorkItemNotFound(id);
    }
    return row.dispatchCount;
  }

  async listAll() {
    return this.db
      .select()
      .from(workItems)
      .orderBy(asc(workItems.createdAt));
  }

  async addDependency(fromId: string, toId: string) {
    await this.db
      .insert(dependencies)
      .values({ fromId, toId })
      .onConflictDoNothing();
  }

  async getDependencies(itemId: string) {
    const rows = await this.db
      .select({ fromId: dependencies.fromId })
      .from(dependencies)
      .where(eq(dependencies.toId, itemId));
    return rows.map((r) => r.fromId);
  }

  async findChildren(parentId: string) {
    return this.db
      .select()
      .from(workItems)
      .where(eq(workItems.parentId, parentId));
  }

  async findDuplicate(level: string, title: string, parentId: string | null) {
    const conditions = parentId
      ? and(
          eq(workItems.level, level),
          eq(workItems.title, title),
          eq(workItems.parentId, parentId),
          eq(workItems.status, "Pending"),
        )
      : and(
          eq(workItems.level, level),
          eq(workItems.title, title),
          isNull(workItems.parentId),
          eq(workItems.status, "Pending"),
        );

    const [row] = await this.db
      .select()
      .from(workItems)
      .where(conditions)
      .limit(1);
    return row ?? null;
  }

  async listAllDependencies() {
    const rows = await this.db
      .select({ fromId: dependencies.fromId, toId: dependencies.toId })
      .from(dependencies);
    return rows;
  }
}

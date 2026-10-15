import { and, eq, asc, desc, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbHandle } from "@ashara/db";
import { workItems, dependencies } from "@ashara/db";
import { parseWorkItemStatus } from "../work-item-language/work-item-status.js";
import { canTransitionTo, InvalidStatusTransition, WorkItemNotFound } from "../work-item-language/transitions.js";
import { parseWorkItemJsonb } from "../work-item-language/work-item-row.js";
import type { FailureVerdict } from "../acl/quality-acl.js";

type WorkItemRow = typeof workItems.$inferSelect;

/** An owner was named for a work item that does not exist or already has one. */
class WorkItemOwnerNotAssignable extends Error {
  constructor(
    readonly workItemId: string,
    readonly workKind: string,
    readonly ownerRoleId: string,
  ) {
    super(
      `cannot assign ${workKind} owner ${ownerRoleId} to work item ${workItemId}: no such item, or it already has an owner`,
    );
    this.name = "WorkItemOwnerNotAssignable";
  }
}

/** A stack statement was given for a work item that does not exist or is neither environment nor implementation work. */
class EnvironmentStatementNotRecordable extends Error {
  constructor(readonly workItemId: string) {
    super(`cannot record an environment statement on work item ${workItemId}: no such item, or it is neither environment nor implementation work`);
    this.name = "EnvironmentStatementNotRecordable";
  }
}

/** A dispatch refund for a work item whose dispatch count is already zero: nothing was counted to give back. */
class DispatchRefundWithoutDispatch extends Error {
  constructor(readonly workItemId: string) {
    super(`cannot refund a dispatch of work item ${workItemId}: its dispatch_count is 0, so no dispatch was counted`);
    this.name = "DispatchRefundWithoutDispatch";
  }
}

/** A save moved a work item into Failed with no verdict on its attempt: nothing could route it by one later. */
class FailedWithoutVerdict extends Error {
  constructor(
    readonly workItemId: string,
    readonly from: string,
  ) {
    super(`cannot save work item ${workItemId} as Failed (from ${from}) with no verdict on whether another attempt can succeed`);
    this.name = "FailedWithoutVerdict";
  }
}

export class WorkItemRowRepository {
  constructor(private readonly db: DbHandle) {}

  /**
   * Validates the three jsonb columns on a work_items row at the database
   * boundary (Discipline A, Zod-at-boundaries). A non-null value that fails its
   * Zod schema throws WorkItemRowCorrupt naming the row's project, item and
   * column — corrupt data is caught here, at the physical read, not deferred to
   * an adapter or domain layer. Null/undefined passes through (absent is a
   * policy default for all three columns).
   */
  private validateRow(row: WorkItemRow): WorkItemRow {
    parseWorkItemJsonb(row);
    return row;
  }

  /**
   * Runs `fn` inside a single database transaction (ADR-029). The callback
   * receives a transaction-scoped repository whose every write participates in
   * the same atomic unit — the batch of work items AND their dependency edges
   * commits or rolls back together, so a mid-loop crash cannot leave orphan
   * items whose missing edges make the Gate consider them prematurely eligible.
   */
  async withTransaction<T>(fn: (repo: WorkItemRowRepository) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new WorkItemRowRepository(tx)));
  }

  async create(item: typeof workItems.$inferInsert) {
    const [row] = await this.db.insert(workItems).values(item).returning();
    return this.validateRow(row);
  }

  /**
   * Records who owns a task (migration 031): its kind of work and the owning
   * role. Only an item with no owner yet takes one; an owner is never replaced.
   */
  async assignOwner(id: string, workKind: string, ownerRoleId: string): Promise<void> {
    const [row] = await this.db
      .update(workItems)
      .set({ workKind, ownerRoleId })
      .where(and(eq(workItems.id, id), sql`${workItems.ownerRoleId} IS NULL`))
      .returning({ id: workItems.id });
    if (!row) throw new WorkItemOwnerNotAssignable(id, workKind, ownerRoleId);
  }

  /**
   * Keeps a statement of the stack (migration 033) with the environment version it holds for
   * (migration 037): an environment task's own, with the version its substrate gate tested; or
   * (migration 043) on an implementation whose verified merge changed the environment's build
   * context (an input, ADR-074 addendum 2 d72 B3), the statement of the version it ran on, with the version its merge produced. Only
   * environment and implementation work take one; a later attempt's statement replaces it.
   */
  async recordEnvironmentStatement(id: string, statement: string, version: string): Promise<void> {
    const [row] = await this.db
      .update(workItems)
      .set({ environmentStatement: statement, environmentStatementVersion: version })
      .where(and(eq(workItems.id, id), inArray(workItems.workKind, ["environment", "implementation"])))
      .returning({ id: workItems.id });
    if (!row) throw new EnvironmentStatementNotRecordable(id);
  }

  /**
   * Records the merge commit Z0 made on the target's main for the task (migration 041), the one
   * record of what was merged. Written before the task is moved to Completed, so a failed write
   * leaves it not Completed. A later merge of the same task (re-opened and merged again)
   * replaces it: the newer commit is on main after the older one. `kind` is how the commit closed
   * the task (migration 049), null only when it was never recorded.
   */
  async recordMergeCommit(id: string, commit: string, kind: "merged" | "already_delivered" | null): Promise<void> {
    const [row] = await this.db
      .update(workItems)
      .set({ mergeCommit: commit, mergeKind: kind })
      .where(eq(workItems.id, id))
      .returning({ id: workItems.id });
    if (!row) throw new WorkItemNotFound(id);
  }

  /**
   * The statement of the project's most recently completed task that recorded it for `version`
   * (an environment task, or an implementation whose verified merge produced that version): the
   * stack that version was chosen for. Null when none did.
   */
  async environmentStatementFor(projectId: string, version: string): Promise<string | null> {
    const [row] = await this.db
      .select({ statement: workItems.environmentStatement })
      .from(workItems)
      .where(
        and(
          eq(workItems.projectId, projectId),
          inArray(workItems.workKind, ["environment", "implementation"]),
          eq(workItems.status, "Completed"),
          eq(workItems.environmentStatementVersion, version),
          isNotNull(workItems.environmentStatement),
        ),
      )
      .orderBy(desc(workItems.updatedAt), desc(workItems.id))
      .limit(1);
    return row?.statement ?? null;
  }

  async findById(id: string) {
    const [row] = await this.db
      .select()
      .from(workItems)
      .where(eq(workItems.id, id))
      .limit(1);
    return row ? this.validateRow(row) : null;
  }

  /**
   * One project's items in `status`. Reads are per project so a corrupt row
   * fails only its own project's read (story s-loop-never-stop-m1).
   */
  async findByProjectAndStatus(projectId: string, status: string) {
    const rows = await this.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.projectId, projectId), eq(workItems.status, status)))
      .orderBy(asc(workItems.createdAt), asc(workItems.id));
    return rows.map((row) => this.validateRow(row));
  }

  /** The projects that hold at least one item in `status`; no jsonb column is read. */
  async projectIdsWithStatus(status: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ projectId: workItems.projectId })
      .from(workItems)
      .where(eq(workItems.status, status))
      .orderBy(asc(workItems.projectId));
    return rows.map((row) => row.projectId);
  }

  /** Ids of every item in one of `statuses`; no jsonb column is read. */
  async listIdsByStatus(statuses: readonly string[]): Promise<string[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db
      .select({ id: workItems.id })
      .from(workItems)
      .where(inArray(workItems.status, [...statuses]));
    return rows.map((row) => row.id);
  }

  /** One project's items, oldest first. A corrupt row fails this project's read only. */
  async listByProject(projectId: string) {
    const rows = await this.db
      .select()
      .from(workItems)
      .where(eq(workItems.projectId, projectId))
      .orderBy(asc(workItems.createdAt), asc(workItems.id));
    return rows.map((row) => this.validateRow(row));
  }

  /**
   * Physical writer for the WorkItem state machine (ADR-029). `expectedPreviousStatus`
   * is the pre-image the caller believes the row holds; callers read it from the domain
   * object before mutating it. The write fails closed with InvalidStatusTransition when:
   *   - the requested transition is not permitted by canTransitionTo (the single guard),
   *     unless it is a same-status metadata write (from === to), which stays legal; or
   *   - the live row no longer holds the claimed pre-image (concurrent modification),
   *     detected by a conditional UPDATE that must affect exactly the targeted row.
   * Quality's verdict on the attempt (migration 058) is written with every move into Failed, which
   * fails closed with FailedWithoutVerdict when none is given, and cleared with every move out of
   * Failed; a write that keeps the status leaves it as it is.
   */
  async save(
    item: { id: string; status: string; blockedReason?: unknown; failureVerdict: FailureVerdict | null; updatedAt: Date },
    expectedPreviousStatus: string,
  ) {
    const from = parseWorkItemStatus(expectedPreviousStatus);
    const to = parseWorkItemStatus(item.status);

    if (from !== to && !canTransitionTo(from, to)) {
      throw new InvalidStatusTransition(item.id, from, to);
    }
    let verdictWrite: { failureVerdict?: FailureVerdict | null } = {};
    if (from !== to && to === "Failed") {
      if (item.failureVerdict === null) throw new FailedWithoutVerdict(item.id, from);
      verdictWrite = { failureVerdict: item.failureVerdict };
    } else if (from !== to && from === "Failed") {
      verdictWrite = { failureVerdict: null };
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
        ...verdictWrite,
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

  /**
   * Takes back one counted dispatch, never below zero, in a single UPDATE: the
   * dispatch seam counted an attempt that a spend-cap refusal stopped, which is
   * not an attempt the retry bound should charge. Returns the post-refund value.
   */
  async refundDispatchCount(id: string): Promise<number> {
    const [row] = await this.db
      .update(workItems)
      .set({ dispatchCount: sql`${workItems.dispatchCount} - 1` })
      .where(and(eq(workItems.id, id), sql`${workItems.dispatchCount} > 0`))
      .returning({ dispatchCount: workItems.dispatchCount });
    if (row) return row.dispatchCount;
    const [exists] = await this.db.select({ id: workItems.id }).from(workItems).where(eq(workItems.id, id)).limit(1);
    if (!exists) throw new WorkItemNotFound(id);
    throw new DispatchRefundWithoutDispatch(id);
  }

  /** Counts one infrastructure fault on the item (migration 048); returns the count after it. */
  async recordInfrastructureFault(id: string): Promise<number> {
    const [row] = await this.db
      .update(workItems)
      .set({ infrastructureFaults: sql`${workItems.infrastructureFaults} + 1` })
      .where(eq(workItems.id, id))
      .returning({ infrastructureFaults: workItems.infrastructureFaults });
    if (!row) throw new WorkItemNotFound(id);
    return row.infrastructureFaults;
  }

  async addDependency(fromId: string, toId: string) {
    await this.db
      .insert(dependencies)
      .values({ fromId, toId })
      .onConflictDoNothing();
  }

  async getDependencies(itemId: string) {
    const rows = await this.db
      .select({ toId: dependencies.toId })
      .from(dependencies)
      .where(eq(dependencies.fromId, itemId));
    return rows.map((r) => r.toId);
  }

  async findChildren(parentId: string) {
    const rows = await this.db
      .select()
      .from(workItems)
      .where(eq(workItems.parentId, parentId));
    return rows.map((row) => this.validateRow(row));
  }

  /**
   * The dependency edges of one project: every edge whose dependent (from) item is the
   * project's. The dependencies table has no project_id; the dependent's row names it.
   */
  async listDependenciesByProject(projectId: string) {
    const rows = await this.db
      .select({ fromId: dependencies.fromId, toId: dependencies.toId })
      .from(dependencies)
      .innerJoin(workItems, eq(workItems.id, dependencies.fromId))
      .where(eq(workItems.projectId, projectId));
    return rows;
  }
}

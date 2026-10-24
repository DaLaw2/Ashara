import { eq } from "drizzle-orm";
import type { DbHandle } from "@ashara/db";
import { projects } from "@ashara/db";

// Delivery's one lock order: a transaction that locks a project's row and rows of its work items
// takes the project row first, through lockProjectRow, and the item rows after it. Two such
// transactions on one project then wait on the first lock and never on each other's second.
//
// The project row is taken FOR NO KEY UPDATE, not FOR UPDATE. It conflicts with every other lock a
// writer takes on the row (FOR NO KEY UPDATE, FOR UPDATE, FOR SHARE, and a plain UPDATE of the row),
// so the project's writers still run one at a time. It does not conflict with the FOR KEY SHARE a
// foreign-key check takes on the project row when a row referencing it is inserted, and such an
// insert can come after an item row is already locked: the plan repair trigger of a task's move to
// Abandoned inserts plan_repairs in the statement that updates the task, and a task's check
// revision inserts task_checks under the task's lock. Under FOR UPDATE that insert would wait on the
// project row while the project row's holder waits on the item row: a deadlock.

/** Locks the project row for the rest of `tx` (FOR NO KEY UPDATE); null when there is no such project. */
export async function lockProjectRow(tx: DbHandle, projectId: string): Promise<{ readonly id: string; readonly lifecycle: string } | null> {
  const [locked] = await tx
    .select({ id: projects.id, lifecycle: projects.lifecycle })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("no key update");
  return locked ?? null;
}

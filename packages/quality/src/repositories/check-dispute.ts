import { count, eq } from "drizzle-orm";
import { checkDisputes } from "@ashara/db/schema/quality";
import type { Database } from "@ashara/db";

// Quality's record of an implementer's disputes of its task's checks.

/** One dispute, as the implementer's attempt ended with it. */
interface NewCheckDispute {
  readonly projectId: string;
  readonly taskId: string;
  readonly checkTaskId: string;
  readonly revision: number;
  readonly checkName: string;
  readonly reason: string;
  readonly evidence: string | null;
}

export class CheckDisputeRepository {
  constructor(private readonly db: Database) {}

  /**
   * Appends the dispute and returns how many disputes its check task has drawn, this one included,
   * read in the same transaction as the insert.
   */
  async record(dispute: NewCheckDispute): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.insert(checkDisputes).values({
        projectId: dispute.projectId,
        taskId: dispute.taskId,
        checkTaskId: dispute.checkTaskId,
        revision: dispute.revision,
        checkName: dispute.checkName,
        reason: dispute.reason,
        evidence: dispute.evidence,
      });
      const [row] = await tx.select({ disputes: count() }).from(checkDisputes).where(eq(checkDisputes.checkTaskId, dispute.checkTaskId));
      // The row just inserted is counted: anything below one means the count read another table state.
      if (row === undefined || row.disputes < 1) {
        throw new CheckDisputeCountUnreadable(dispute.checkTaskId, row?.disputes ?? null);
      }
      return row.disputes;
    });
  }
}

/** The dispute count read back after the insert did not include the insert. */
class CheckDisputeCountUnreadable extends Error {
  constructor(
    readonly checkTaskId: string,
    readonly counted: number | null,
  ) {
    super(`disputes of check task ${checkTaskId} were counted as ${counted ?? "no row"} right after one was recorded`);
    this.name = "CheckDisputeCountUnreadable";
  }
}

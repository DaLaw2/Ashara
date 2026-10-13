import { count, eq } from "drizzle-orm";
import { parseProjectId } from "@ashara/shared";
import type { ProjectBlockCause } from "@ashara/shared";
import type { Database } from "../connection.js";
import { checkDisputes } from "../schema.js";
import { ClientMessageRepository } from "./client-message.js";
import { ProjectRepository } from "./project.js";

// Quality's record of an implementer's disputes of its task's checks (migration 039).

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

  /**
   * Blocks an active project and, only when this call blocked it, posts the one report telling the
   * client why, in one transaction: a project already blocked keeps its first cause and gets no
   * second report.
   */
  async blockProjectWithReport(projectId: string, cause: ProjectBlockCause, report: string): Promise<"blocked" | "already-blocked"> {
    const id = parseProjectId(projectId);
    return this.db.transaction(async (tx) => {
      const blocked = await new ProjectRepository(tx).block(id, cause);
      if (blocked === "blocked") {
        await new ClientMessageRepository(tx).insertOutbound({ projectId: id, kind: "report", body: report, inReplyTo: null });
      }
      return blocked;
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

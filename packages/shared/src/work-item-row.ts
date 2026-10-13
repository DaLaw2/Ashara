import { describeErrorChain } from "./error-chain.js";
import { BlockedReasonCorrupt, parseStoredBlockedReason, type StoredBlockedReason } from "./blocked-reason.js";
import { parseStoredSuccessCriteria, SuccessCriteriaCorrupt, type StoredSuccessCriteria } from "./success-criteria.js";
import { parseStoredTaskSpec, TaskSpecCorrupt, type StoredTaskSpec } from "./task-spec.js";

type WorkItemJsonbColumn = "task_spec" | "success_criteria" | "blocked_reason";

/**
 * A work_items row whose jsonb column holds a value its schema rejects. It
 * names the project, so one project's bad row blocks that project instead of
 * failing a read for every project (story s-loop-never-stop-m1). The column
 * parser's own error is the cause.
 */
export class WorkItemRowCorrupt extends Error {
  constructor(
    readonly projectId: string,
    readonly itemId: string,
    readonly column: WorkItemJsonbColumn,
    cause: TaskSpecCorrupt | SuccessCriteriaCorrupt | BlockedReasonCorrupt,
  ) {
    super(`work item ${itemId} (project ${projectId}): ${column} does not parse`, { cause });
    this.name = "WorkItemRowCorrupt";
  }
}

/** The identity and jsonb columns of a work_items row, as read from the database. */
interface WorkItemJsonbRow {
  readonly id: string;
  readonly projectId: string;
  readonly taskSpec: unknown;
  readonly successCriteria: unknown;
  readonly blockedReason: unknown;
}

interface ParsedWorkItemJsonb {
  readonly taskSpec: StoredTaskSpec | undefined;
  readonly successCriteria: StoredSuccessCriteria | undefined;
  readonly blockedReason: StoredBlockedReason | undefined;
}

function column<T>(row: WorkItemJsonbRow, name: WorkItemJsonbColumn, parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof TaskSpecCorrupt || err instanceof SuccessCriteriaCorrupt || err instanceof BlockedReasonCorrupt) {
      throw new WorkItemRowCorrupt(row.projectId, row.id, name, err);
    }
    throw err;
  }
}

/**
 * Parses every jsonb column of a work_items row. Null passes through as
 * undefined (each column's absence is a policy default); a present value its
 * schema rejects throws WorkItemRowCorrupt.
 */
export function parseWorkItemJsonb(row: WorkItemJsonbRow): ParsedWorkItemJsonb {
  return {
    taskSpec: column(row, "task_spec", () => parseStoredTaskSpec(row.taskSpec)),
    successCriteria: column(row, "success_criteria", () => parseStoredSuccessCriteria(row.successCriteria)),
    blockedReason: column(row, "blocked_reason", () => parseStoredBlockedReason(row.blockedReason)),
  };
}

/** Why a project was blocked (migration 025): the error's class and its full chain. */
export interface ProjectBlockCause {
  readonly errorClass: string;
  readonly reason: string;
}

export function projectBlockCause(err: Error): ProjectBlockCause {
  return { errorClass: err.name, reason: describeErrorChain(err) };
}

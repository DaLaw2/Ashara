/**
 * Subdirectory of `workdirBase` that holds each task's records, written Z0-side and never into
 * the worktree: `records/<taskId>/<sessionId>/` carries the dispatch's brief and the attempt's
 * conversation, locatable by task id after the worktree is gone.
 */
export const CONVERSATION_RECORDS_DIR = "records";

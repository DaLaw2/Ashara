import type { Database } from "@ashara/db";
import { createTerminalSweepStore } from "@ashara/server/acceptance-store";

/**
 * Records the terminal sweep each due stop and halt episode of a project `ours` admits is owed, as
 * one that could not run on a commit: the core loop's terminal-sweep step, which runs before any
 * report that carries the guarantee table, with no substrate behind it. Every other suite's
 * terminal is left alone.
 */
export async function sweepTerminalsOf(db: Database, ours: (projectId: string) => boolean): Promise<void> {
  const store = createTerminalSweepStore(db);
  for (const due of await store.dueTerminalSweeps()) {
    if (!ours(due.projectId)) continue;
    await store.recordTerminalSweep({
      projectId: due.projectId,
      terminal: due.terminal,
      mainCommit: null,
      environmentVersion: null,
      checkedTasks: [],
      uncheckedTasks: [],
      checkOutcomes: [],
      details: "No terminal sweep ran: no execution substrate stands behind this test.",
    });
  }
}

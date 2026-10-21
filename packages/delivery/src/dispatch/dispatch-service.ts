import { pruneStaleEnvironmentImages } from "@ashara/execution-infra";
import type { ExecutionResult } from "@ashara/quality";
import { readEnvironmentDefinition } from "@ashara/quality";
import type { DispatchServiceDeps, TaskDescriptor } from "./dispatch-types.js";
import { executeTask } from "./execute-task.js";

// Delivery's dispatch of one task: it resolves what decides the work, builds the brief,
// staffs the attempt, runs it in Workplace and hands every verdict to Quality's verification ports.
// What happens to the task afterwards is the core loop's verdict routing, from the ExecutionResult.

export class DispatchService {
  private readonly deps: DispatchServiceDeps;

  constructor(deps: DispatchServiceDeps) {
    this.deps = deps;
  }

  /**
   * `targetProjectPath` is the project's validated target checkout: a project without one is
   * blocked by the caller before dispatch, since only that checkout gives the worktree a git dir
   * Z0 owns (execution-infra's host-git.ts) and the merge a place to land.
   */
  async execute(task: TaskDescriptor, targetProjectPath: string): Promise<ExecutionResult> {
    try {
      return await executeTask({ context: { deps: this.deps, verification: this.deps.verifiers }, task, targetProjectPath });
    } finally {
      // Every build_environment call leaves an image: once the environment task
      // ends, however it ends, only main's current version and images in use are kept.
      if (task.workKind === "environment") {
        await pruneStaleEnvironmentImages(task.projectId, targetProjectPath, this.deps.environment.images, readEnvironmentDefinition);
      }
    }
  }
}

import { and, eq, inArray } from "drizzle-orm";
import { projects } from "@ashara/db";
import type { DbHandle } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";

/**
 * Every status a project can hold: the `projects_status_known` CHECK constraint
 * (migrations/049_project_accepted.sql) admits exactly these.
 */
export const PROJECT_STATUSES = ["active", "blocked", "stopped", "accepted"] as const;

/**
 * Engagement's one guard over projects.status (O3 c, ADR-080 d3): the engagement lifecycle is
 * Engagement's. A project is active from its tender; the client's stop ends work on it from any
 * status but stopped; a passed acceptance sweep accepts an active one. The halt ('blocked') and the
 * way back from it are Delivery's (its project-halt repository), and no write of Engagement's
 * names them as a destination.
 */
export const PROJECT_LIFECYCLE = {
  stop: { from: ["active", "blocked", "accepted"], to: "stopped" },
  accept: { from: ["active"], to: "accepted" },
} as const;

/** The project is not in a status the move admits: nothing was written. */
class ProjectLifecycleRefused extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly move: keyof typeof PROJECT_LIFECYCLE,
  ) {
    super(
      `cannot ${move} project ${projectId}: it is not in one of the statuses ` +
        `${PROJECT_LIFECYCLE[move].from.join(", ")}, or there is no such project`,
    );
    this.name = "ProjectLifecycleRefused";
  }
}

/**
 * Moves the project to 'accepted' (migration 049), inside the caller's transaction, which holds the
 * project row locked and records the passed sweep the projects_acceptance_guard trigger requires.
 */
export async function acceptProject(tx: DbHandle, projectId: ProjectId): Promise<void> {
  const [moved] = await tx
    .update(projects)
    .set({ status: PROJECT_LIFECYCLE.accept.to })
    .where(and(eq(projects.id, projectId), inArray(projects.status, [...PROJECT_LIFECYCLE.accept.from])))
    .returning({ id: projects.id });
  if (!moved) throw new ProjectLifecycleRefused(projectId, "accept");
}

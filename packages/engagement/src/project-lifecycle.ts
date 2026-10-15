import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { projectAtWork, projectHalted, projects } from "@ashara/db";
import type { DbHandle, PROJECT_LIFECYCLES } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";

/**
 * Every state the client is shown a project in: its Engagement lifecycle (PROJECT_LIFECYCLES,
 * projects_lifecycle_known, migration 059), or 'blocked' while Delivery's halt is open.
 */
export const PROJECT_STATUSES = ["active", "blocked", "stopped", "accepted"] as const;

type ProjectLifecycle = (typeof PROJECT_LIFECYCLES)[number];

/**
 * Engagement's one guard over projects.lifecycle (O3 c, ADR-080 d3; migration 059), the column's
 * only writer. A project is active from its tender; the client's stop ends work on it from active
 * (halted or not) or accepted; a passed acceptance sweep accepts an active project Delivery has not
 * halted. The halt itself is Delivery's (its project-halt repository), read here only through db's
 * projectHalted.
 */
const PROJECT_LIFECYCLE = {
  stop: { from: ["active", "accepted"], to: "stopped" },
  accept: { from: ["active"], to: "accepted" },
} as const satisfies Record<string, { readonly from: readonly ProjectLifecycle[]; readonly to: ProjectLifecycle }>;

/** The project is not in a lifecycle state the move admits: nothing was written. */
class ProjectLifecycleRefused extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly move: keyof typeof PROJECT_LIFECYCLE,
    readonly found: string | null,
  ) {
    super(
      `cannot ${move} project ${projectId}: expected one of ${PROJECT_LIFECYCLE[move].from.join(", ")}` +
        `${move === "accept" ? " and not halted" : ""}, found ${found === null ? "no project row" : `'${found}'`}`,
    );
    this.name = "ProjectLifecycleRefused";
  }
}

/** What the client's stop found: whether it moved the project, and whether Delivery had it halted. */
type StopOutcome = { readonly kind: "stopped"; readonly wasHalted: boolean } | { readonly kind: "already-stopped" };

/**
 * Moves the project to 'stopped' (migration 028), inside the caller's transaction, with the project
 * row locked. A halt it finds is ended as 'client_stop' by the projects_stop_ends_halt trigger. A
 * project already stopped is left as it is; any other refusal throws ProjectLifecycleRefused.
 */
export async function stopProject(tx: DbHandle, projectId: ProjectId): Promise<StopOutcome> {
  const [locked] = await tx.select({ lifecycle: projects.lifecycle }).from(projects).where(eq(projects.id, projectId)).for("update");
  if (locked?.lifecycle === PROJECT_LIFECYCLE.stop.to) return { kind: "already-stopped" };
  // Read after the lock, in its own statement: a halt committed while the lock was awaited is seen.
  const [halt] = await tx.select({ halted: projectHalted(projects.id) }).from(projects).where(eq(projects.id, projectId));
  const [moved] = await tx
    .update(projects)
    .set({ lifecycle: PROJECT_LIFECYCLE.stop.to })
    .where(and(eq(projects.id, projectId), inArray(projects.lifecycle, [...PROJECT_LIFECYCLE.stop.from])))
    .returning({ id: projects.id });
  if (!moved || !halt) throw new ProjectLifecycleRefused(projectId, "stop", locked?.lifecycle ?? null);
  return { kind: "stopped", wasHalted: z.boolean().parse(halt.halted) };
}

/**
 * Moves the project to 'accepted' (migration 049), inside the caller's transaction, which holds the
 * project row locked and records the passed sweep the projects_acceptance_guard trigger requires.
 */
export async function acceptProject(tx: DbHandle, projectId: ProjectId): Promise<void> {
  const [moved] = await tx
    .update(projects)
    .set({ lifecycle: PROJECT_LIFECYCLE.accept.to })
    .where(and(eq(projects.id, projectId), inArray(projects.lifecycle, [...PROJECT_LIFECYCLE.accept.from]), projectAtWork()))
    .returning({ id: projects.id });
  if (moved) return;
  const [found] = await tx.select({ lifecycle: projects.lifecycle }).from(projects).where(eq(projects.id, projectId));
  throw new ProjectLifecycleRefused(projectId, "accept", found === undefined ? null : found.lifecycle);
}

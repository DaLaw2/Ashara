import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ProjectRepository, noOpenStop, projectBlocks, projects } from "@ashara/db";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { ProjectBlockCause } from "../project-halt.js";

/**
 * Delivery's one guard over projects.status (O3 c, ADR-080 d3): the only moves Delivery makes. A
 * halt takes an active project to 'blocked'; a resumption (the substrate probe, or the operator's
 * unblock once the cause is cleared) takes a halted one back to 'active'. Every other status is
 * Engagement's (its project-lifecycle.ts), and no write of Delivery's names one.
 */
export const PROJECT_HALT = {
  halt: { from: "active", to: "blocked" },
  resume: { from: "blocked", to: "active" },
} as const;

/** A project id named for a write that matches no project row. */
class ProjectNotFound extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly operation: string,
  ) {
    super(`cannot ${operation}: no project ${projectId}`);
    this.name = "ProjectNotFound";
  }
}

/** An unblock named a project that is not blocked. */
class ProjectNotBlocked extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly status: string,
  ) {
    super(`cannot unblock project ${projectId}: it is '${status}', not '${PROJECT_HALT.resume.from}'`);
    this.name = "ProjectNotBlocked";
  }
}

/** A blocked project with no open block episode: migration 040's trigger or backfill did not run for it. */
class BlockEpisodeMissing extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`cannot return project ${projectId} to work: it is blocked but has no open block episode to end`);
    this.name = "BlockEpisodeMissing";
  }
}

/**
 * The Project Record as Delivery reads and halts it: Engagement's record (db's ProjectRepository)
 * and the halt, whose every write goes through PROJECT_HALT.
 */
export class ProjectHaltRepository extends ProjectRepository {
  /**
   * Blocks an active project and records why (migration 025), with the cause's
   * category (migration 040); the projects_block_episode trigger opens the block's
   * episode, which the Liaison reports to the client once. A project already
   * blocked keeps its status and the cause it was first blocked with, so the
   * earliest cause stays on record. A project that does not exist throws.
   */
  async block(id: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked"> {
    const [row] = await this.db
      .update(projects)
      .set({
        status: PROJECT_HALT.halt.to,
        blockedCategory: cause.category,
        blockedErrorClass: cause.errorClass,
        blockedReason: cause.reason,
      })
      .where(and(eq(projects.id, id), eq(projects.status, PROJECT_HALT.halt.from)))
      .returning({ id: projects.id });
    if (row) return "blocked";
    const [existing] = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).limit(1);
    if (!existing) throw new ProjectNotFound(id, "block the project");
    return "already-blocked";
  }

  /**
   * Blocks every active project with no stop awaiting the Liaison, with one cause: the
   * deployment's spend cap, which binds them all (migration 048). Each block opens its episode
   * (the projects_block_episode trigger). Returns the projects blocked.
   */
  async blockAllActive(cause: ProjectBlockCause): Promise<ProjectId[]> {
    const rows = await this.db
      .update(projects)
      .set({
        status: PROJECT_HALT.halt.to,
        blockedCategory: cause.category,
        blockedErrorClass: cause.errorClass,
        blockedReason: cause.reason,
      })
      .where(and(eq(projects.status, PROJECT_HALT.halt.from), noOpenStop(projects.id)))
      .returning({ id: projects.id });
    return rows.map((row) => parseProjectId(row.id, "projects.id"));
  }

  /**
   * The projects halted on infrastructure (migration 048) whose halt the client has been told,
   * oldest first: what the substrate probe resumes. A halt not yet reported is not listed: the
   * halt report is due only while its episode is open, so ending it first would leave the client
   * told of a resumption it was never told the pause of.
   */
  async listInfrastructureHalted(): Promise<ProjectId[]> {
    const rows = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.status, PROJECT_HALT.resume.from),
          eq(projects.blockedCategory, "infrastructure"),
          noOpenStop(projects.id),
          sql`EXISTS (SELECT 1 FROM project_blocks b WHERE b.project_id = ${projects.id} AND b.ended_at IS NULL AND b.report_id IS NOT NULL)`,
        ),
      )
      .orderBy(asc(projects.createdAt), asc(projects.id));
    return rows.map((row) => parseProjectId(row.id, "projects.id"));
  }

  /**
   * The automatic way out of an infrastructure halt (migration 048): in one transaction with the
   * project row locked, its open episode is ended as 'probe_passed' with what the probe observed,
   * and the project returns to 'active' with its cause cleared. The Liaison then tells the client,
   * once, that work resumed. A project no longer halted on infrastructure is left as it is: "moved".
   * A halt whose own report is not yet posted is left as it is too, "unreported": its report is
   * due only while the episode is open, so it is told before it can end.
   */
  async resumeFromInfrastructureHalt(id: ProjectId, evidence: string): Promise<"resumed" | "moved" | "unreported"> {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ status: projects.status, category: projects.blockedCategory })
        .from(projects)
        .where(eq(projects.id, id))
        .for("update");
      if (!locked) throw new ProjectNotFound(id, "resume the project");
      if (locked.status !== PROJECT_HALT.resume.from || locked.category !== "infrastructure") return "moved";
      const [open] = await tx
        .select({ reportId: projectBlocks.reportId })
        .from(projectBlocks)
        .where(and(eq(projectBlocks.projectId, id), isNull(projectBlocks.endedAt)));
      if (!open) throw new BlockEpisodeMissing(id);
      if (open.reportId === null) return "unreported";
      const [episode] = await tx
        .update(projectBlocks)
        .set({ endedAt: sql`now()`, endKind: "probe_passed", resumeEvidence: evidence })
        .where(and(eq(projectBlocks.projectId, id), isNull(projectBlocks.endedAt)))
        .returning({ id: projectBlocks.id });
      if (!episode) throw new BlockEpisodeMissing(id);
      await tx
        .update(projects)
        .set({ status: PROJECT_HALT.resume.to, blockedCategory: null, blockedErrorClass: null, blockedReason: null })
        .where(eq(projects.id, id));
      return "resumed";
    });
  }

  /**
   * The operator's way out of 'blocked' (migration 040), after the cause is cleared: in one
   * transaction with the project row locked, the open block episode is ended with who and why,
   * and the project returns to 'active' with its cause cleared. A project whose first planning
   * gave up has its planning record reset, so first planning runs again from no attempts; a
   * plan revision's failed attempts are reset likewise (migration 042). The
   * Liaison then tells the client, once, that work resumed. Only a blocked project is unblocked:
   * any other status throws ProjectNotBlocked, and nothing is written.
   */
  async unblock(id: ProjectId, by: string, reason: string): Promise<{ readonly episodeId: string }> {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ status: projects.status, planStoppedAt: projects.planStoppedAt })
        .from(projects)
        .where(eq(projects.id, id))
        .for("update");
      if (!locked) throw new ProjectNotFound(id, "unblock the project");
      if (locked.status !== PROJECT_HALT.resume.from) throw new ProjectNotBlocked(id, locked.status);

      const [episode] = await tx
        .update(projectBlocks)
        .set({ endedAt: sql`now()`, endKind: "unblocked", unblockedBy: by, unblockReason: reason })
        .where(and(eq(projectBlocks.projectId, id), isNull(projectBlocks.endedAt)))
        .returning({ id: projectBlocks.id });
      if (!episode) throw new BlockEpisodeMissing(id);

      const planningReset = locked.planStoppedAt === null ? {} : { planStoppedAt: null, planAttempts: 0, planLastError: null };
      // A revision that gave up is tried again from no attempts (migration 042).
      await tx
        .update(projects)
        .set({
          status: PROJECT_HALT.resume.to,
          blockedCategory: null,
          blockedErrorClass: null,
          blockedReason: null,
          replanAttempts: 0,
          replanLastError: null,
          ...planningReset,
        })
        .where(eq(projects.id, id));
      return { episodeId: episode.id };
    });
  }
}

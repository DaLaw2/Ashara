import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ProjectRepository, projectBlocks, projectRowColumns, projects, toProjectRow } from "@ashara/db";
import type { DbHandle, ProjectRow } from "@ashara/db";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import { firstPlanUnreported, noOpenStop, projectActive, projectAtWork } from "../acl/engagement-predicates-acl.js";
import { SPEND_CAP_ERROR_CLASS } from "../acl/finance-acl.js";
import { pendingRepair, projectHalted } from "../predicates.js";
import type { ProjectBlockCause } from "../project-halt.js";

// Delivery's one guard over the project halt. A project is halted
// while it has an open project_blocks episode; this module is the only writer of that episode and
// of the halt's cause on the project row (blocked_category, blocked_error_class, blocked_reason). A
// halt opens an episode on a project at work (Engagement's lifecycle 'active', not halted); a
// resumption (the substrate probe, or the operator's unblock once the cause is cleared) ends it.
// Engagement's lifecycle column is never written here; the client's stop ends a halt it finds
// through the projects_stop_ends_halt trigger.

/**
 * The project's planning outcomes are reported to the client: it is at work, or its halt is the
 * deployment's spend cap. That halt stops the process's full cycles for good, so a plan written
 * in the cycle that reached the cap, or one whose report's post faulted there, is reported by the
 * halted cycles; the plan stands, and the client's block report says why no work follows it. Any
 * other halt holds the report until the project resumes.
 */
export const projectReportsPlans = (): SQL =>
  sql`(${projectAtWork()} OR (${projectActive()} AND EXISTS (SELECT 1 FROM project_blocks cb
    WHERE cb.project_id = ${projects.id} AND cb.ended_at IS NULL AND cb.error_class = ${SPEND_CAP_ERROR_CLASS.deployment})))`;

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

/** An unblock named a project that is not halted. */
class ProjectNotBlocked extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly lifecycle: string,
  ) {
    super(`cannot unblock project ${projectId}: it is '${lifecycle}' and not halted (no open block episode)`);
    this.name = "ProjectNotBlocked";
  }
}

/** The open episode read under the project's lock was gone when it was to be ended: nothing was written. */
class BlockEpisodeMissing extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`cannot return project ${projectId} to work: its open block episode was ended while the project row was locked`);
    this.name = "BlockEpisodeMissing";
  }
}

/** Locks the project row for the rest of `tx`; null when there is no such project. */
async function lockProject(tx: DbHandle, id: ProjectId): Promise<{ readonly lifecycle: string; readonly planStoppedAt: Date | null } | null> {
  const [locked] = await tx
    .select({ lifecycle: projects.lifecycle, planStoppedAt: projects.planStoppedAt })
    .from(projects)
    .where(eq(projects.id, id))
    .for("update");
  return locked ?? null;
}

/**
 * The open episode of a project whose row `tx` holds locked: read in its own statement after the
 * lock, so a halt committed by a writer the lock waited for is seen.
 */
async function openEpisode(tx: DbHandle, id: ProjectId): Promise<{ readonly kind: string; readonly reportId: string | null } | null> {
  const [open] = await tx
    .select({ kind: projectBlocks.kind, reportId: projectBlocks.reportId })
    .from(projectBlocks)
    .where(and(eq(projectBlocks.projectId, id), isNull(projectBlocks.endedAt)));
  return open ?? null;
}

/**
 * The episode a halt opens: its kind, class and chain, on a budget_cap halt the amounts its cap was
 * judged on, and on a work_budget halt the work ledger as it stood.
 */
function episodeOf(cause: ProjectBlockCause) {
  return {
    kind: cause.category,
    errorClass: cause.errorClass,
    reason: cause.reason,
    spend: cause.category === "budget_cap" ? cause.spend : null,
    work: cause.category === "work_budget" ? cause.work : null,
  };
}

/**
 * Halts the project for first planning giving up, inside `tx`, which holds the project row locked
 * and has just stamped plan_stopped_at on it: the episode is 'planning_stopped', its reason the
 * last planning error.
 */
export async function haltForPlanningStopped(tx: DbHandle, id: ProjectId, lastError: string | null): Promise<void> {
  await tx.insert(projectBlocks).values({ projectId: id, kind: "planning_stopped", errorClass: null, reason: lastError });
}

/** A project as the client sees it. */
export interface ProjectRecord extends ProjectRow {
  /**
   * 'blocked' while Delivery has the project halted, otherwise Engagement's lifecycle (active,
   * stopped, accepted). Only an active project is ever halted.
   */
  readonly status: string;
}

/** The columns a ProjectRecord is read from, the halt among them, in one statement. */
const recordColumns = { ...projectRowColumns, halted: projectHalted(projects.id) };

function toRecord(row: Parameters<typeof toProjectRow>[0] & { readonly halted: unknown }): ProjectRecord {
  const project = toProjectRow(row);
  return { ...project, status: z.boolean().parse(row.halted) ? "blocked" : project.lifecycle };
}

/**
 * The Project Record as Delivery reads and halts it: Engagement's record (db's ProjectRepository)
 * read with the halt, whose every write is here.
 */
export class ProjectHaltRepository extends ProjectRepository {
  override async get(id: ProjectId): Promise<ProjectRecord | null> {
    const [row] = await this.db.select(recordColumns).from(projects).where(eq(projects.id, id)).limit(1);
    return row ? toRecord(row) : null;
  }

  /** This client's projects, newest first. There is no unscoped listing. */
  override async listByClient(clientId: string): Promise<ProjectRecord[]> {
    const rows = await this.db
      .select(recordColumns)
      .from(projects)
      .where(eq(projects.clientId, clientId))
      .orderBy(desc(projects.createdAt), desc(projects.id));
    return rows.map(toRecord);
  }

  /**
   * The projects whose work may be dispatched: at work (active, not halted), no stop
   * awaiting the Liaison, no plan repair awaited and no first-plan report awaited
   * (firstPlanUnreported), oldest first. A client's correction awaiting its revision holds only the
   * tasks citing a key it affects, each parked on its own row, so it does not hold the project.
   * This read is the dispatch decision: a stop committed after it is ordered
   * after the dispatch it gated.
   */
  async listActiveIds(): Promise<ProjectId[]> {
    const rows = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(projectAtWork(), noOpenStop(projects.id), sql`NOT ${pendingRepair(projects.id)}`, sql`NOT ${firstPlanUnreported()}`))
      .orderBy(asc(projects.createdAt), asc(projects.id));
    return rows.map((row) => parseProjectId(row.id, "projects.id"));
  }

  /**
   * Halts a project at work and records why, with the cause's category,
   * opening the episode the Liaison reports to the client once. A project already halted
   * keeps the cause it was first halted with, so the earliest cause stays on record; a stopped or
   * accepted one is not halted. Either is "already-blocked". A project that does not exist throws.
   */
  async block(id: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked"> {
    return this.db.transaction(async (tx) => {
      if (!(await lockProject(tx, id))) throw new ProjectNotFound(id, "block the project");
      const [halted] = await tx
        .update(projects)
        .set({ blockedCategory: cause.category, blockedErrorClass: cause.errorClass, blockedReason: cause.reason })
        .where(and(eq(projects.id, id), projectAtWork()))
        .returning({ id: projects.id });
      if (!halted) return "already-blocked";
      await tx.insert(projectBlocks).values({ projectId: id, ...episodeOf(cause) });
      return "blocked";
    });
  }

  /**
   * Halts every project at work with no stop awaiting the Liaison, with one cause: the
   * deployment's spend cap, which binds them all. Each halt opens its episode.
   * Returns the projects halted.
   */
  async blockAllActive(cause: ProjectBlockCause): Promise<ProjectId[]> {
    return this.db.transaction(async (tx) => {
      const candidates = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(projectActive(), noOpenStop(projects.id)))
        .orderBy(asc(projects.id))
        .for("update");
      if (candidates.length === 0) return [];
      const halted = await tx
        .update(projects)
        .set({ blockedCategory: cause.category, blockedErrorClass: cause.errorClass, blockedReason: cause.reason })
        .where(and(inArray(projects.id, candidates.map((row) => row.id)), projectAtWork(), noOpenStop(projects.id)))
        .returning({ id: projects.id });
      if (halted.length === 0) return [];
      await tx
        .insert(projectBlocks)
        .values(halted.map((row) => ({ projectId: row.id, ...episodeOf(cause) })));
      return halted.map((row) => parseProjectId(row.id, "projects.id"));
    });
  }

  /**
   * The projects halted on infrastructure whose halt the client has been told,
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
          noOpenStop(projects.id),
          sql`EXISTS (SELECT 1 FROM project_blocks b WHERE b.project_id = ${projects.id} AND b.ended_at IS NULL
            AND b.kind = 'infrastructure' AND b.report_id IS NOT NULL)`,
        ),
      )
      .orderBy(asc(projects.createdAt), asc(projects.id));
    return rows.map((row) => parseProjectId(row.id, "projects.id"));
  }

  /**
   * The automatic way out of an infrastructure halt: in one transaction with the
   * project row locked, its open episode is ended as 'probe_passed' with what the probe observed,
   * and its cause cleared. The Liaison then tells the client, once, that work resumed. A project no
   * longer halted on infrastructure is left as it is: "moved". A halt whose own report is not yet
   * posted is left as it is too, "unreported": its report is due only while the episode is open,
   * so it is told before it can end.
   */
  async resumeFromInfrastructureHalt(id: ProjectId, evidence: string): Promise<"resumed" | "moved" | "unreported"> {
    return this.db.transaction(async (tx) => {
      if (!(await lockProject(tx, id))) throw new ProjectNotFound(id, "resume the project");
      const open = await openEpisode(tx, id);
      if (!open || open.kind !== "infrastructure") return "moved";
      if (open.reportId === null) return "unreported";
      const [episode] = await tx
        .update(projectBlocks)
        .set({ endedAt: sql`now()`, endKind: "probe_passed", resumeEvidence: evidence })
        .where(and(eq(projectBlocks.projectId, id), isNull(projectBlocks.endedAt)))
        .returning({ id: projectBlocks.id });
      if (!episode) throw new BlockEpisodeMissing(id);
      await tx
        .update(projects)
        .set({ blockedCategory: null, blockedErrorClass: null, blockedReason: null })
        .where(eq(projects.id, id));
      return "resumed";
    });
  }

  /**
   * The operator's way out of a halt, after the cause is cleared: in one
   * transaction with the project row locked, the open block episode is ended with who and why,
   * and the cause cleared. A project whose first planning gave up has its planning record reset,
   * so first planning runs again from no attempts; a plan revision's failed attempts are reset
   * likewise. The Liaison then tells the client, once, that work resumed. Only a
   * halted project is unblocked: any other throws ProjectNotBlocked, and nothing is written.
   */
  async unblock(id: ProjectId, by: string, reason: string): Promise<{ readonly episodeId: string }> {
    return this.db.transaction(async (tx) => {
      const locked = await lockProject(tx, id);
      if (!locked) throw new ProjectNotFound(id, "unblock the project");
      if (!(await openEpisode(tx, id))) throw new ProjectNotBlocked(id, locked.lifecycle);

      const [episode] = await tx
        .update(projectBlocks)
        .set({ endedAt: sql`now()`, endKind: "unblocked", unblockedBy: by, unblockReason: reason })
        .where(and(eq(projectBlocks.projectId, id), isNull(projectBlocks.endedAt)))
        .returning({ id: projectBlocks.id });
      if (!episode) throw new BlockEpisodeMissing(id);

      const planningReset = locked.planStoppedAt === null ? {} : { planStoppedAt: null, planAttempts: 0, planLastError: null };
      // A revision that gave up is tried again from no attempts.
      await tx
        .update(projects)
        .set({
          blockedCategory: null,
          blockedErrorClass: null,
          blockedReason: null,
          replanAttempts: 0,
          replanLastError: null,
          replanLastFailure: null,
          ...planningReset,
        })
        .where(eq(projects.id, id));
      return { episodeId: episode.id };
    });
  }
}

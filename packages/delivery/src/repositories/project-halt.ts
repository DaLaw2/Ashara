import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ProjectRepository, projectRowColumns, projects, toProjectRow } from "@ashara/db";
import { projectBlocks } from "@ashara/db/schema/delivery";
import type { DbHandle, ProjectRow } from "@ashara/db";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import { restartClientReadings } from "../acl/engagement-acl.js";
import { firstPlanUnreported, haltReported, noOpenStop, planRevisionTold, projectActive, projectAtWork } from "../acl/engagement-predicates-acl.js";
import { SPEND_CAP_ERROR_CLASS } from "../acl/finance-acl.js";
import { HALT_KINDS, pendingRepair, projectHalted, type HaltKind } from "../predicates.js";
import type { ProjectBlockCause } from "../project-halt.js";
import { resetOnUnblock } from "./project-plan.js";
import { lockProjectRow } from "./project-lock.js";

// Delivery's one guard over the project halt. A project is halted
// while it has an open project_blocks episode, which records the halt's cause; this module is the
// only writer of that episode. A halt opens an episode on a project at work (Engagement's lifecycle
// 'active', not halted); a resumption (the substrate probe, or the operator's unblock once the cause is cleared) ends it, and
// so does the client's stop, through endHaltOnStop, which Engagement's stop calls in its own
// transaction. Engagement's lifecycle column is never written here, and whether a halt was told is
// Engagement's told record, read through its published haltReported.

/**
 * A revision of the project's plan adds behaviour beyond what the contract states (its summary lists
 * the assumptions it recorded) and its report is not yet posted: its tasks rest on assumptions the
 * client has not read, so none of the project's tasks is dispatched until that report tells them.
 * A first plan's are held by firstPlanUnreported, whose report names them.
 */
const plannedBehaviourUntold = (): SQL =>
  sql`EXISTS (SELECT 1 FROM plan_revisions pb WHERE pb.project_id = ${projects.id}
    AND jsonb_array_length(pb.summary -> 'assumptions') > 0 AND NOT ${planRevisionTold(sql`pb.id`)})`;

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

/**
 * The open episode of a project whose row `tx` holds locked: read in its own statement after the
 * lock, so a halt committed by a writer the lock waited for is seen.
 */
async function openEpisode(tx: DbHandle, id: ProjectId): Promise<{ readonly kind: HaltKind; readonly reported: boolean } | null> {
  const [open] = await tx
    .select({ kind: projectBlocks.kind, reported: haltReported(projectBlocks.id) })
    .from(projectBlocks)
    .where(and(eq(projectBlocks.projectId, id), isNull(projectBlocks.endedAt)));
  return open === undefined ? null : { kind: z.enum(HALT_KINDS).parse(open.kind), reported: z.boolean().parse(open.reported) };
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
 * and has just stamped planning stopped on its planning record: the episode is 'planning_stopped',
 * its reason the last planning error.
 */
export async function haltForPlanningStopped(tx: DbHandle, id: ProjectId, lastError: string | null): Promise<void> {
  await tx.insert(projectBlocks).values({ projectId: id, kind: "planning_stopped", errorClass: null, reason: lastError });
}

/**
 * Ends the project's open halt episode, if it has one, as 'client_stop', inside `tx`: the
 * transaction in which Engagement moves the project to 'stopped' with its row locked. The deferred
 * project_halt_consistent check refuses, at the commit, a stopped project left halted.
 */
export async function endHaltOnStop(tx: DbHandle, id: ProjectId): Promise<void> {
  await tx
    .update(projectBlocks)
    .set({ endedAt: sql`now()`, endKind: "client_stop" })
    .where(and(eq(projectBlocks.projectId, id), isNull(projectBlocks.endedAt)));
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
   * awaiting the Liaison, no plan repair awaited, no first-plan report awaited
   * (firstPlanUnreported) and no report awaited of a revision that adds behaviour beyond the contract
   * (plannedBehaviourUntold), oldest first. A client's correction awaiting its revision holds only the
   * tasks citing a key it affects, each parked on its own row, so it does not hold the project.
   * This read is the dispatch decision: a stop committed after it is ordered
   * after the dispatch it gated.
   */
  async listActiveIds(): Promise<ProjectId[]> {
    const rows = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          projectAtWork(),
          noOpenStop(projects.id),
          sql`NOT ${pendingRepair(projects.id)}`,
          sql`NOT ${firstPlanUnreported()}`,
          sql`NOT ${plannedBehaviourUntold()}`,
        ),
      )
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
      if (!(await lockProjectRow(tx, id))) throw new ProjectNotFound(id, "block the project");
      const [atWork] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, id), projectAtWork()));
      if (!atWork) return "already-blocked";
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
        .for("no key update");
      if (candidates.length === 0) return [];
      const halted = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(inArray(projects.id, candidates.map((row) => row.id)), projectAtWork(), noOpenStop(projects.id)))
        .orderBy(asc(projects.id));
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
    return this.listReportedHalts("infrastructure");
  }

  /**
   * The projects halted on client_wait whose halt the client has been told, oldest first: what the
   * client's answer resumes. A halt not yet reported is not listed, as with listInfrastructureHalted.
   */
  async listClientWaitHalted(): Promise<ProjectId[]> {
    return this.listReportedHalts("client_wait");
  }

  private async listReportedHalts(kind: "infrastructure" | "client_wait"): Promise<ProjectId[]> {
    const rows = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          noOpenStop(projects.id),
          sql`EXISTS (SELECT 1 FROM project_blocks b WHERE b.project_id = ${projects.id} AND b.ended_at IS NULL
            AND b.kind = ${kind} AND ${haltReported(sql`b.id`)})`,
        ),
      )
      .orderBy(asc(projects.createdAt), asc(projects.id));
    return rows.map((row) => parseProjectId(row.id, "projects.id"));
  }

  /**
   * The automatic way out of an infrastructure halt: in one transaction with the
   * project row locked, its open episode is ended as 'probe_passed' with what the probe observed,
   * and the client's unconsumed messages whose count the halt's end resets
   * are read afresh (restartClientReadings). The Liaison then tells the client, once, that work resumed. A project no
   * longer halted on infrastructure is left as it is: "moved". A halt whose own report is not yet
   * posted is left as it is too, "unreported": its report is due only while the episode is open,
   * so it is told before it can end.
   */
  async resumeFromInfrastructureHalt(id: ProjectId, evidence: string): Promise<"resumed" | "moved" | "unreported"> {
    return this.resumeOnItsOwn(id, "infrastructure", "probe_passed", evidence);
  }

  /**
   * The automatic way out of a client_wait halt, as resumeFromInfrastructureHalt: the open episode is
   * ended as 'answered' with what the client answered, "moved" when the project is not so halted.
   */
  async resumeFromClientWait(id: ProjectId, evidence: string): Promise<"resumed" | "moved" | "unreported"> {
    return this.resumeOnItsOwn(id, "client_wait", "answered", evidence);
  }

  private async resumeOnItsOwn(
    id: ProjectId,
    kind: "infrastructure" | "client_wait",
    endKind: "probe_passed" | "answered",
    evidence: string,
  ): Promise<"resumed" | "moved" | "unreported"> {
    return this.db.transaction(async (tx) => {
      if (!(await lockProjectRow(tx, id))) throw new ProjectNotFound(id, "resume the project");
      const open = await openEpisode(tx, id);
      if (!open || open.kind !== kind) return "moved";
      if (!open.reported) return "unreported";
      const [episode] = await tx
        .update(projectBlocks)
        .set({ endedAt: sql`now()`, endKind, resumeEvidence: evidence })
        .where(and(eq(projectBlocks.projectId, id), isNull(projectBlocks.endedAt)))
        .returning({ id: projectBlocks.id });
      if (!episode) throw new BlockEpisodeMissing(id);
      await restartClientReadings(tx, id, open.kind);
      return "resumed";
    });
  }

  /**
   * The operator's way out of a halt, after the cause is cleared: in one
   * transaction with the project row locked, the open block episode is ended with who and why. A
   * project whose first planning gave up has its planning record reset, so first planning runs
   * again from no attempts; a plan revision's failed attempts are reset likewise (resetOnUnblock),
   * and so is every reading of the client's unconsumed messages whose count the halt's end resets
   * (restartClientReadings). The Liaison then tells the client, once, that work resumed. Only a
   * halted project is unblocked: any other throws ProjectNotBlocked, and nothing is written.
   */
  async unblock(id: ProjectId, by: string, reason: string): Promise<{ readonly episodeId: string }> {
    return this.db.transaction(async (tx) => {
      const locked = await lockProjectRow(tx, id);
      if (!locked) throw new ProjectNotFound(id, "unblock the project");
      const open = await openEpisode(tx, id);
      if (!open) throw new ProjectNotBlocked(id, locked.lifecycle);

      const [episode] = await tx
        .update(projectBlocks)
        .set({ endedAt: sql`now()`, endKind: "unblocked", unblockedBy: by, unblockReason: reason })
        .where(and(eq(projectBlocks.projectId, id), isNull(projectBlocks.endedAt)))
        .returning({ id: projectBlocks.id });
      if (!episode) throw new BlockEpisodeMissing(id);

      await resetOnUnblock(tx, id);
      await restartClientReadings(tx, id, open.kind);
      return { episodeId: episode.id };
    });
  }
}

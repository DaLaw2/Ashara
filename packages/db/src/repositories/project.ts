import { and, asc, desc, eq, isNotNull, isNull, sql, type AnyColumn } from "drizzle-orm";
import { parseProjectId, type ProjectBlockCause, type ProjectId } from "@ashara/shared";
import type { DbHandle } from "../connection.js";
import { projectBlocks, projects } from "../schema.js";

export interface ProjectRecord {
  readonly id: ProjectId;
  readonly name: string;
  readonly status: string;
  /** The client this project belongs to (migration 018). */
  readonly clientId: string;
  readonly createdAt: Date;
  /** The target workspace Delivery works in (migration 024); null until first minted. */
  readonly workspacePath: string | null;
}

type ProjectRow = typeof projects.$inferSelect;

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: parseProjectId(row.id, "projects.id"),
    name: row.name,
    status: row.status,
    clientId: row.clientId,
    createdAt: row.createdAt,
    workspacePath: row.workspacePath,
  };
}

/** A workspace path could not be recorded on the project. */
/**
 * True while the project has no inbound stop the Liaison has yet to consume
 * (migration 028). The Liaison consumes stops once per cycle, at its top; a stop
 * the client sends later in the cycle must already hold, so every reader that
 * admits only active projects to take in, plan, report on or dispatch also
 * requires this. A stop committed before such a read is honoured by it.
 */
export const noOpenStop = (projectId: AnyColumn) =>
  sql`NOT EXISTS (SELECT 1 FROM client_messages s WHERE s.project_id = ${projectId}
    AND s.direction = 'inbound' AND s.kind = 'stop' AND s.consumed_at IS NULL)`;

/**
 * The project awaits a plan repair (migration 045): a task the failure router gave up that no plan
 * revision has re-planned around yet. Its dispatch is held until one has (listActiveIds).
 */
export const pendingRepair = (projectId: AnyColumn) =>
  sql`EXISTS (SELECT 1 FROM plan_repairs pr WHERE pr.project_id = ${projectId} AND pr.plan_revision_id IS NULL)`;

/**
 * The project awaits a plan revision for a client's change (migration 052): an answer that changed
 * an assumption the plan was built on, which no revision has taken in yet. Its dispatch is held
 * until one has (listActiveIds).
 */
export const pendingChange = (projectId: AnyColumn) =>
  sql`EXISTS (SELECT 1 FROM replan_requests rr WHERE rr.project_id = ${projectId} AND rr.plan_revision_id IS NULL)`;

class WorkspacePathNotRecorded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly candidatePath: string,
    readonly reason: string,
  ) {
    super(`cannot record workspace path ${candidatePath} on project ${projectId}: ${reason}`);
    this.name = "WorkspacePathNotRecorded";
  }
}

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

/** The Project Record (architecture K3): one row per tender, owned by one client. */
export class ProjectRepository {
  constructor(private readonly db: DbHandle) {}

  async create(name: string, clientId: string): Promise<ProjectRecord> {
    const [row] = await this.db.insert(projects).values({ name, clientId }).returning();
    return toRecord(row);
  }

  async get(id: ProjectId): Promise<ProjectRecord | null> {
    const [row] = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return row ? toRecord(row) : null;
  }

  /** This client's projects, newest first. There is no unscoped listing. */
  async listByClient(clientId: string): Promise<ProjectRecord[]> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(eq(projects.clientId, clientId))
      .orderBy(desc(projects.createdAt), desc(projects.id));
    return rows.map(toRecord);
  }

  /**
   * Stores `path` as the project's workspace unless one is already stored, and
   * returns whichever is stored. The first writer wins inside the UPDATE itself,
   * so two racing dispatches cannot leave one project with two workspaces.
   */
  async recordWorkspacePath(id: ProjectId, path: string): Promise<string> {
    const [claimed] = await this.db
      .update(projects)
      .set({ workspacePath: path })
      .where(and(eq(projects.id, id), isNull(projects.workspacePath)))
      .returning({ workspacePath: projects.workspacePath });
    if (claimed?.workspacePath) return claimed.workspacePath;
    const existing = await this.get(id);
    if (!existing) throw new WorkspacePathNotRecorded(id, path, "the project does not exist");
    if (existing.workspacePath === null) {
      throw new WorkspacePathNotRecorded(id, path, "the conditional UPDATE matched no row yet the path is still unset");
    }
    return existing.workspacePath;
  }

  /**
   * The projects whose work may be dispatched: status 'active', no stop
   * awaiting the Liaison, no revision awaited for a client's change (migration 052: a client
   * answer contradicted an assumption the plan was built on) and no plan repair awaited, oldest first.
   * This read is the dispatch decision: a stop committed after it is ordered
   * after the dispatch it gated.
   */
  async listActiveIds(): Promise<ProjectId[]> {
    const rows = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.status, "active"), noOpenStop(projects.id), sql`NOT ${pendingChange(projects.id)}`, sql`NOT ${pendingRepair(projects.id)}`))
      .orderBy(asc(projects.createdAt), asc(projects.id));
    return rows.map((row) => parseProjectId(row.id, "projects.id"));
  }

  /** Every project with a target workspace, whatever its status: what startup prunes environment images of. */
  async listWithWorkspace(): Promise<Array<{ readonly id: ProjectId; readonly workspacePath: string }>> {
    const rows = await this.db
      .select({ id: projects.id, workspacePath: projects.workspacePath })
      .from(projects)
      .where(isNotNull(projects.workspacePath))
      .orderBy(asc(projects.createdAt), asc(projects.id));
    const listed: Array<{ readonly id: ProjectId; readonly workspacePath: string }> = [];
    for (const row of rows) {
      if (row.workspacePath !== null) listed.push({ id: parseProjectId(row.id, "projects.id"), workspacePath: row.workspacePath });
    }
    return listed;
  }

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
        status: "blocked",
        blockedCategory: cause.category,
        blockedErrorClass: cause.errorClass,
        blockedReason: cause.reason,
      })
      .where(and(eq(projects.id, id), eq(projects.status, "active")))
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
        status: "blocked",
        blockedCategory: cause.category,
        blockedErrorClass: cause.errorClass,
        blockedReason: cause.reason,
      })
      .where(and(eq(projects.status, "active"), noOpenStop(projects.id)))
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
          eq(projects.status, "blocked"),
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
      if (locked.status !== "blocked" || locked.category !== "infrastructure") return "moved";
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
        .set({ status: "active", blockedCategory: null, blockedErrorClass: null, blockedReason: null })
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
      if (locked.status !== "blocked") throw new ProjectNotBlocked(id, locked.status);

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
          status: "active",
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

/** An unblock named a project that is not blocked. */
class ProjectNotBlocked extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly status: string,
  ) {
    super(`cannot unblock project ${projectId}: it is '${status}', not 'blocked'`);
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

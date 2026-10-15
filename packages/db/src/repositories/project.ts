import { and, asc, desc, eq, isNotNull, isNull, sql, type AnyColumn } from "drizzle-orm";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { DbHandle } from "../connection.js";
import { projects } from "../schema/index.js";

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

// An answer the Liaison has yet to read may change the vision: the project is
// planned once its answers are in (migration 038).
export const noOpenAnswer = () =>
  sql`NOT EXISTS (SELECT 1 FROM client_messages a WHERE a.project_id = projects.id
    AND a.direction = 'inbound' AND a.kind = 'answer' AND a.consumed_at IS NULL)`;

/** A workspace path could not be recorded on the project. */
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

/**
 * The Project Record (architecture K3): one row per tender, owned by one client. Its halt, the
 * 'blocked' status and its episode, is Delivery's (O3 c, ADR-080 d3): Delivery's repository extends
 * this one with the only writes of it.
 */
export class ProjectRepository {
  constructor(protected readonly db: DbHandle) {}

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
}

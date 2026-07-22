import { and, desc, eq } from "drizzle-orm";

import {
  ContractBodySchema,
  parseProjectId,
  type ProjectId,
  type ProjectContract,
  type ContractBody,
} from "@ashara/shared";
import type { ContractRepository as ContractRepositoryPort } from "@ashara/planning";
import { RepositoryError, ContractVersionConflict } from "@ashara/planning";

import type { DbHandle } from "../connection.js";
import { projectContracts } from "../schema.js";

/** Postgres SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * True when `err` (or any error in its `cause` chain, since Drizzle may wrap the pg
 * DatabaseError) carries the unique-violation SQLSTATE. Pure type-narrowing, no
 * unvalidated `as`.
 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current != null; depth++) {
    if (pgErrorCode(current) === UNIQUE_VIOLATION) {
      return true;
    }
    current = errorCause(current);
  }
  return false;
}

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const { code } = err;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

function errorCause(err: unknown): unknown {
  if (typeof err === "object" && err !== null && "cause" in err) {
    return err.cause;
  }
  return undefined;
}

/**
 * Postgres-backed ProjectContract store (ADR-028, migration 019). Append-only and
 * per-project versioned: `insertVersion` writes a row at exactly the version the
 * domain chose (seed=1, amend=latest+1). The UNIQUE (project_id, version)
 * constraint is the physical guard against reusing a version; a violation is
 * translated at this boundary into a typed ContractVersionConflict so a raw driver
 * 23505 never leaks to a domain caller (Discipline C). Every body crosses the
 * ContractBody Zod schema on the way in (write boundary) and on the way out of
 * jsonb (read boundary).
 */
export class ContractRepository implements ContractRepositoryPort {
  constructor(private readonly db: DbHandle) {}

  async withTransaction<T>(fn: (repo: ContractRepositoryPort) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new ContractRepository(tx)));
  }

  async insertVersion(projectId: ProjectId, version: number, body: ContractBody): Promise<ProjectContract> {
    const validated = ContractBodySchema.parse(body);
    let rows;
    try {
      rows = await this.db
        .insert(projectContracts)
        .values({ projectId, version, contract: validated })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ContractVersionConflict(projectId, version);
      }
      throw err;
    }
    const [row] = rows;
    if (!row) {
      throw new RepositoryError(`insertVersion returned no row for project ${projectId}`);
    }
    return this.hydrate(row.projectId, row.version, row.contract);
  }

  async getLatest(projectId: ProjectId): Promise<ProjectContract | null> {
    const [row] = await this.db
      .select()
      .from(projectContracts)
      .where(eq(projectContracts.projectId, projectId))
      .orderBy(desc(projectContracts.version))
      .limit(1);
    return row ? this.hydrate(row.projectId, row.version, row.contract) : null;
  }

  async getByVersion(projectId: ProjectId, version: number): Promise<ProjectContract | null> {
    const [row] = await this.db
      .select()
      .from(projectContracts)
      .where(and(eq(projectContracts.projectId, projectId), eq(projectContracts.version, version)))
      .limit(1);
    return row ? this.hydrate(row.projectId, row.version, row.contract) : null;
  }

  private hydrate(projectId: string, version: number, contract: unknown): ProjectContract {
    const body = ContractBodySchema.parse(contract);
    return { projectId: parseProjectId(projectId), version, ...body };
  }
}

import type { ProjectId, ProjectContract, ContractBody } from "@ashara/shared";

/**
 * Persistence port for the ProjectContract (ADR-028, mig-phase-8). Per-project and
 * append-only versioned: `insertVersion` writes a NEW row at a caller-chosen
 * version, so every prior version stays intact for audit. Reads return the latest
 * by default and a specific version for audit. The db package implements this
 * against Postgres; the Planning domain (PlanningService) depends only on this
 * interface, never on db.
 *
 * Version policy lives in the domain (PlanningService), not the repository: a seed
 * targets version 1 and an amend targets latest+1. The repository is a dumb
 * versioned writer whose only invariant is that a version, once written, is never
 * silently overwritten — enforced by the unique (project_id, version) constraint,
 * which it surfaces as a typed ContractVersionConflict.
 *
 * `withTransaction` gives PlanningService.amendContract an atomic read-latest →
 * validate → insert unit, so a divergent-delta rejection or an injected mid-amend
 * failure leaves the prior version untouched.
 */
export interface ContractRepository {
  /** The current (highest-version) contract for the project, or null if none. */
  getLatest(projectId: ProjectId): Promise<ProjectContract | null>;
  /** A specific historical version, for audit; null if that version does not exist. */
  getByVersion(projectId: ProjectId, version: number): Promise<ProjectContract | null>;
  /**
   * Persists `body` at exactly `version`, validating it at the write boundary and
   * returning the stored contract. If that version already exists for the project,
   * fails closed with a typed ContractVersionConflict (never a raw driver 23505).
   */
  insertVersion(projectId: ProjectId, version: number, body: ContractBody): Promise<ProjectContract>;
  /** Runs `fn` atomically; the handed repository is transaction-scoped. */
  withTransaction<T>(fn: (repo: ContractRepository) => Promise<T>): Promise<T>;
}

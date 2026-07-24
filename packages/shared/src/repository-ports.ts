import type { ProjectId } from "./ids.js";
import type { ProjectContract, ContractBody } from "./contract.js";

/**
 * Published Language: persistence port for the ProjectContract.
 * Defined in the Shared Kernel so both the domain layer (planning) and
 * the infrastructure layer (db) depend on this interface — neither
 * imports the other. ADR-044.
 */
export interface ContractRepository {
  getLatest(projectId: ProjectId): Promise<ProjectContract | null>;
  insertVersion(projectId: ProjectId, version: number, body: ContractBody): Promise<ProjectContract>;
  withTransaction<T>(fn: (repo: ContractRepository) => Promise<T>): Promise<T>;
}

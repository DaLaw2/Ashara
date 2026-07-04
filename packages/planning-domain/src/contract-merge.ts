import type { ContractBody, ContractDelta, Endpoint, ContractModule, Mount } from "@ashara/shared";
import { normalizePath } from "@ashara/shared";

import { ContractConflict } from "./errors.js";

/**
 * Applies an additive contract delta onto a base body (ADR-028, mig-phase-8),
 * merging each registry collection by identity. Pure and total apart from the one
 * fail-closed exit: a divergent redeclaration throws ContractConflict. The
 * singleton facts (techStack, entryPoint) are carried through unchanged — a delta
 * cannot renegotiate them in this phase.
 *
 * Identity & conflict rules:
 *  - Endpoints key on `ref`. Same ref with a different method or path -> conflict.
 *    Same ref, same method+path -> idempotent; optional provenance fields
 *    (sourceModule, declaredBy) are filled in if the base lacked them.
 *  - Modules key on `path`. Same path with a different purpose -> conflict.
 *    Same path, same purpose -> idempotent; `exports` are unioned and `reuseOnly`
 *    stays sticky (once reuse-only, an idempotent restatement cannot un-set it).
 *  - Mounts and checks are additive with exact-duplicate suppression; nothing
 *    else consumes them yet, so no cross-referential enforcement in this phase.
 *
 * The incoming items are folded one at a time onto a working copy, so two items
 * inside a single delta that contradict each other are caught the same way as a
 * delta contradicting the base.
 */
export function applyContractDelta(base: ContractBody, delta: ContractDelta): ContractBody {
  return {
    knowledge: base.knowledge,
    endpoints: mergeEndpoints(base.endpoints, delta.endpoints ?? []),
    modules: mergeModules(base.modules, delta.modules ?? []),
    mounts: mergeMounts(base.mounts, delta.mounts ?? []),
  };
}

function mergeEndpoints(base: readonly Endpoint[], incoming: readonly Endpoint[]): Endpoint[] {
  const merged = base.map((e) => ({ ...e, path: normalizePath(e.path) }));
  for (const next of incoming) {
    const nextPath = normalizePath(next.path);
    const existing = merged.find((e) => e.ref === next.ref);
    if (!existing) {
      merged.push({ ...next, path: nextPath });
      continue;
    }
    // Paths are compared in canonical form (Run-10 blocker #2): "/api/todos/{id}"
    // and "/api/todos/:id" are the SAME endpoint, not a divergence. A genuinely
    // different method (PUT vs PATCH) or a truly different path (a lost param
    // segment) still throws — a residual conflict the caller decides how to contain.
    if (existing.method !== next.method || existing.path !== nextPath) {
      throw new ContractConflict("endpoint-divergence", next.ref, existing, { ...next, path: nextPath });
    }
    // purpose is descriptive, not identity — an idempotent restatement keeps the base's.
    if (existing.sourceModule === undefined && next.sourceModule !== undefined) {
      existing.sourceModule = next.sourceModule;
    }
    if (existing.declaredBy === undefined && next.declaredBy !== undefined) {
      existing.declaredBy = next.declaredBy;
    }
    // Durable scope verdict (r12-t1): sticky like the provenance above — once
    // reconciliation records an endpoint out-of-scope, an idempotent restatement
    // fills it into the base rather than dropping it.
    if (existing.outOfScope === undefined && next.outOfScope !== undefined) {
      existing.outOfScope = next.outOfScope;
    }
  }
  return merged;
}

function mergeModules(base: readonly ContractModule[], incoming: readonly ContractModule[]): ContractModule[] {
  const merged = base.map((m) => ({ ...m }));
  for (const next of incoming) {
    const existing = merged.find((m) => m.path === next.path);
    if (!existing) {
      merged.push({ ...next });
      continue;
    }
    if (existing.purpose !== next.purpose) {
      throw new ContractConflict("module-purpose-divergence", next.path, existing, next);
    }
    if (existing.exports !== undefined || next.exports !== undefined) {
      existing.exports = unionExports(existing.exports, next.exports);
    }
    existing.reuseOnly = existing.reuseOnly || next.reuseOnly;
    if (existing.providerWorkItem === undefined && next.providerWorkItem !== undefined) {
      existing.providerWorkItem = next.providerWorkItem;
    }
  }
  return merged;
}

function unionExports(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] {
  const seen = new Set<string>([...(a ?? []), ...(b ?? [])]);
  return [...seen];
}

function mergeMounts(base: readonly Mount[], incoming: readonly Mount[]): Mount[] {
  const merged = base.map((m) => ({ ...m }));
  for (const next of incoming) {
    const duplicate = merged.some((m) => m.endpointRef === next.endpointRef && m.mountedAt === next.mountedAt);
    if (!duplicate) {
      merged.push({ ...next });
    }
  }
  return merged;
}


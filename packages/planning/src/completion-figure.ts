import type { ProjectContract, ProjectKnowledgeNode } from "@ashara/shared";
import { nodesByKind } from "@ashara/shared";

// ---------------------------------------------------------------------------
// CompletionFigure — a single continuous measure of project completion derived
// from the contract's declared surface and observable evidence.
// ---------------------------------------------------------------------------

export interface BasisItem {
  readonly source: "endpoint" | "check" | "module";
  readonly label: string;
  readonly satisfied: boolean;
}

export type CompletionFigure =
  | {
      readonly kind: "measured";
      readonly ratio: number;
      readonly numerator: number;
      readonly denominator: number;
      readonly basis: readonly BasisItem[];
    }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * What the caller can currently observe about the project. Every map is
 * optional — a missing map means that class of evidence was not collected,
 * and every item in that class counts as unsatisfied (fail-closed).
 */
export interface CompletionEvidence {
  readonly endpointProbes?: ReadonlyMap<string, { status: number | null }>;
  readonly checkResults?: ReadonlyMap<string, boolean>;
  readonly moduleExistence?: ReadonlyMap<string, boolean>;
}

/**
 * Extract the command string used as the check-result map key from a
 * knowledge node's meta. Returns `undefined` when the node carries no
 * executable command (criterion-only check).
 */
function checkCommandKey(node: ProjectKnowledgeNode): string | undefined {
  const raw = node.meta?.["command"];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  // The key is the shell argv joined by space — the same shape the caller
  // uses when populating CompletionEvidence.checkResults.
  return raw.join(" ");
}

/**
 * Compute a single completion figure from the contract's declared surface
 * and whatever evidence is available. Pure function — no IO, no side effects.
 *
 * Fail-closed: missing evidence counts as NOT satisfied; an empty contract
 * returns `unknown` rather than a vacuously-true 100%.
 */
export function computeCompletionFigure(
  contract: ProjectContract | null,
  evidence: CompletionEvidence,
): CompletionFigure {
  if (contract === null) {
    return { kind: "unknown", reason: "no contract available" };
  }

  const basis: BasisItem[] = [];

  // --- Endpoints (identity: ref, exclude outOfScope) ---
  for (const ep of contract.endpoints) {
    if (ep.outOfScope === true) continue;
    const probe = evidence.endpointProbes?.get(ep.ref);
    const satisfied =
      probe !== undefined &&
      probe.status !== null &&
      probe.status >= 200 &&
      probe.status < 300;
    basis.push({ source: "endpoint", label: ep.ref, satisfied });
  }

  // --- Checks (knowledge nodes of kind 'check' with a command) ---
  const checkNodes = nodesByKind(contract.knowledge, "check");
  for (const node of checkNodes) {
    const key = checkCommandKey(node);
    if (key === undefined) continue; // no executable command — not measurable
    const result = evidence.checkResults?.get(key);
    basis.push({ source: "check", label: node.label, satisfied: result === true });
  }

  // --- Modules (identity: path, exclude reuseOnly) ---
  for (const mod of contract.modules) {
    if (mod.reuseOnly === true) continue;
    const exists = evidence.moduleExistence?.get(mod.path);
    basis.push({ source: "module", label: mod.path, satisfied: exists === true });
  }

  const denominator = basis.length;
  if (denominator === 0) {
    return { kind: "unknown", reason: "contract declares no measurable items" };
  }

  const numerator = basis.filter((b) => b.satisfied).length;
  const ratio = numerator / denominator;

  return { kind: "measured", ratio, numerator, denominator, basis };
}

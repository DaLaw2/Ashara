import type { ContractBody, ContractDelta, ProjectKnowledge } from "@ashara/shared";

/**
 * Applies an additive contract delta onto a base body (ADR-028). Knowledge merges
 * by node KIND (ADR-046): a kind the base already established is authoritative and
 * untouched, a kind the base lacks is added. This keeps seed-once semantics for
 * facts already stated while closing the trap where an empty seed made the graph
 * permanently empty.
 */
export function applyContractDelta(base: ContractBody, delta: ContractDelta): ContractBody {
  return {
    knowledge: mergeKnowledge(base.knowledge, delta.knowledge),
  };
}

/**
 * Adds nodes whose KIND is absent from the base, never overwriting a kind the
 * base already established (nor an id it already uses). Incoming edges ride along
 * only when both of their endpoints resolve inside the merged node set, so the
 * graph can never gain a dangling edge from a partially-adopted delta.
 */
function mergeKnowledge(
  base: ProjectKnowledge,
  incoming: ProjectKnowledge,
): ProjectKnowledge {
  const establishedKinds = new Set(base.nodes.map((n) => n.kind));
  const takenIds = new Set(base.nodes.map((n) => n.id));
  const added = incoming.nodes.filter((n) => !establishedKinds.has(n.kind) && !takenIds.has(n.id));
  if (added.length === 0) return base;

  const nodes = [...base.nodes, ...added];
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgeKey = (e: { from: string; to: string; rel: string }): string => `${e.from}|${e.to}|${e.rel}`;
  const seenEdges = new Set(base.edges.map(edgeKey));

  const edges = [...base.edges];
  for (const edge of incoming.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    if (seenEdges.has(edgeKey(edge))) continue;
    seenEdges.add(edgeKey(edge));
    edges.push({ ...edge });
  }

  return { nodes, edges };
}

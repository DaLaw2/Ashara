import { z } from "zod";
import type { ProjectId } from "./ids.js";

/**
 * ProjectContract — the machine-readable project record between Planning and
 * Development (ADR-028). Its body is the project knowledge graph (ADR-038). Every
 * read/write of this shape crosses the Zod boundary: callers hand in bodies and
 * deltas that are parsed before they are trusted, and jsonb read back from
 * Postgres is `unknown` until parsed here.
 */

// --- Project Knowledge Graph (ADR-038) ---

const ProjectKnowledgeNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  meta: z.record(z.string(), z.unknown()).optional(),
}).strict();

const ProjectKnowledgeEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  rel: z.string().min(1),
}).strict();

export const ProjectKnowledgeSchema = z.object({
  nodes: z.array(ProjectKnowledgeNodeSchema),
  edges: z.array(ProjectKnowledgeEdgeSchema),
}).strict();

export type ProjectKnowledgeNode = z.infer<typeof ProjectKnowledgeNodeSchema>;
export type ProjectKnowledge = z.infer<typeof ProjectKnowledgeSchema>;

export function nodeByKind(graph: ProjectKnowledge, kind: string): ProjectKnowledgeNode | undefined {
  return graph.nodes.find(n => n.kind === kind);
}

/**
 * The authored contract body: everything a caller declares. `projectId` (the key)
 * and `version` (monotonic, repo-assigned) are NOT part of the body — they are
 * supplied/assigned by the persistence layer, so an author can never invent a
 * version or contradict the key.
 */
export const ContractBodySchema = z
  .object({
    knowledge: ProjectKnowledgeSchema,
  })
  .strict();

/**
 * An additive amendment. `knowledge` is SEED-ONCE PER KIND (ADR-046): the merge
 * adds node kinds the base lacks and never overwrites a kind already established.
 */
export const ContractDeltaSchema = z
  .object({
    knowledge: ProjectKnowledgeSchema,
  })
  .strict();

export type ContractBody = z.infer<typeof ContractBodySchema>;
export type ContractInput = ContractBody;
export type ContractDelta = z.infer<typeof ContractDeltaSchema>;

/**
 * The domain-facing contract: the body plus the repo-managed key and version.
 * `projectId` carries the `ProjectId` brand (ADR-028) — the repository produces
 * it via `parseProjectId` at the read boundary so the brand is never assumed
 * without validation.
 */
export type ProjectContract = ContractBody & {
  readonly projectId: ProjectId;
  readonly version: number;
};

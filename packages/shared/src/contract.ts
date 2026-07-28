import { z } from "zod";
import type { ProjectId } from "./ids.js";

/**
 * ProjectContract — the machine-readable spec between Planning and Development
 * (ADR-028, mig-phase-8). It records the cross-task intent that today lives only
 * as natural language: which endpoints the project must expose, which modules
 * exist (and may be reused, not recreated), how the entry point mounts them, and
 * the checks that gate the whole. Every read/write of this shape crosses the Zod
 * boundary — external callers hand in bodies/deltas that are parsed before they
 * are trusted, and jsonb read back from Postgres is `unknown` until parsed here.
 *
 * Identity rules (the seat of amend-conflict detection, see contract-merge.ts):
 *  - an endpoint's logical identity is its `ref` (a stable slug the decomposer
 *    assigns, e.g. "auth.register"). The concrete `method` + `path` are attributes
 *    of that identity: re-declaring the same `ref` at a DIVERGENT method or path
 *    is a conflict, never a silent overwrite. This is what lets a completion
 *    amendment say "this is the register endpoint, now observed at /api" and be
 *    caught against the declared "/api/register" instead of masquerading as a
 *    second, unrelated endpoint.
 *  - a module's identity is its `path`. Re-registering the same path with a
 *    DIFFERENT purpose is a conflict; the same path with the same purpose is an
 *    idempotent restatement that merges (union of exports).
 */

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

const ENDPOINT_SOURCES = ["decomposition", "spec-derivation"] as const;

export const HttpMethodSchema = z.enum(HTTP_METHODS);
const EndpointSourceSchema = z.enum(ENDPOINT_SOURCES);

/**
 * A declared HTTP endpoint. `ref` is the stable logical identity (conflict key);
 * `sourceModule` (the module that serves it) and `declaredBy` (the work item that
 * declared it) are provenance, optional because they may only be known once the
 * serving task completes.
 */
const EndpointSchema = z
  .object({
    ref: z.string().min(1),
    method: HttpMethodSchema,
    path: z.string().min(1),
    purpose: z.string().min(1),
    sourceModule: z.string().min(1).optional(),
    declaredBy: z.string().uuid().optional(),
    source: EndpointSourceSchema.optional(),
    /**
     * A DURABLE scope verdict (ADR-032 §2, r12-t1). Set true when coverage
     * reconciliation — the only pass that holds the vision+plan corpus — judged this
     * a spec-derivation invention absent from vision and plan (Run-11's
     * logout/refresh/me class). Persisting it lets the corpus-LESS readers (the
     * rollup guard, the termination completeness check) treat the endpoint as
     * informational-not-blocking WITHOUT re-deriving scope they cannot compute.
     * Optional and backward-compatible: absent on every pre-r12 row, which parses as
     * "not yet judged" (still a blocking gap until reconciliation marks it).
     */
    outOfScope: z.boolean().optional(),
  })
  .strict();

/**
 * A registered module. `path` is the identity (conflict key). `reuseOnly` marks a
 * module briefs must tell downstream tasks to import rather than recreate — the
 * lever against the Run-9 cross-task type-mismatch failure. `providerWorkItem` is
 * provenance.
 */
const ModuleSchema = z
  .object({
    path: z.string().min(1),
    purpose: z.string().min(1),
    exports: z.array(z.string().min(1)).optional(),
    reuseOnly: z.boolean(),
    providerWorkItem: z.string().uuid().optional(),
  })
  .strict();

/** Entry-point mount manifest: an endpoint `ref` mounted at a concrete prefix. */
const MountSchema = z
  .object({
    endpointRef: z.string().min(1),
    mountedAt: z.string().min(1),
  })
  .strict();

/**
 * A gate check. `criterion` is the human-readable assertion; `command` is the
 * shell argv to run it — kept as a typed array so a criterion string is NEVER
 * conflated with (and executed as) a command (Debt R8-F6b).
 */
const CheckSchema = z
  .object({
    criterion: z.string().min(1),
    command: z.array(z.string().min(1)).nonempty().optional(),
  })
  .strict();

// --- Project Knowledge Graph (ADR-038) ---

export const ProjectKnowledgeNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  meta: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const ProjectKnowledgeEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  rel: z.string().min(1),
}).strict();

export const ProjectKnowledgeSchema = z.object({
  nodes: z.array(ProjectKnowledgeNodeSchema),
  edges: z.array(ProjectKnowledgeEdgeSchema),
}).strict();

export type ProjectKnowledgeNode = z.infer<typeof ProjectKnowledgeNodeSchema>;
type ProjectKnowledgeEdge = z.infer<typeof ProjectKnowledgeEdgeSchema>;
export type ProjectKnowledge = z.infer<typeof ProjectKnowledgeSchema>;

export function nodesByKind(graph: ProjectKnowledge, kind: string): ProjectKnowledgeNode[] {
  return graph.nodes.filter(n => n.kind === kind);
}

export function nodeByKind(graph: ProjectKnowledge, kind: string): ProjectKnowledgeNode | undefined {
  return graph.nodes.find(n => n.kind === kind);
}

export function nodeLabel(graph: ProjectKnowledge, kind: string): string | undefined {
  return graph.nodes.find(n => n.kind === kind)?.label;
}

export function nodeLabels(graph: ProjectKnowledge, kind: string): string[] {
  return graph.nodes.filter(n => n.kind === kind).map(n => n.label);
}

/**
 * The authored contract body: everything a caller declares. `projectId` (the key)
 * and `version` (monotonic, repo-assigned) are NOT part of the body — they are
 * supplied/assigned by the persistence layer, so an author can never invent a
 * version or contradict the key.
 *
 * NOTE (ADR-038): techStack, entryPoint, checks migrated into `knowledge` graph.
 * Existing DB rows with the old shape will fail to parse — a contract re-seed
 * is needed before Run 14c.
 */
export const ContractBodySchema = z
  .object({
    knowledge: ProjectKnowledgeSchema,
    endpoints: z.array(EndpointSchema),
    modules: z.array(ModuleSchema),
    mounts: z.array(MountSchema),
    excludePaths: z.array(z.string()).optional(),
  })
  .strict();

/**
 * An additive amendment. Each registry collection is merged by identity with
 * conflict detection (contract-merge.ts).
 *
 * `knowledge` is amendable (ADR-046) but SEED-ONCE PER KIND: the merge adds node
 * kinds the base lacks and never overwrites a kind already established. Before
 * this, knowledge was writable only at version 1, so a project whose seed carried
 * an empty graph — the normal outcome for any non-HTTP target — was permanently
 * unable to state what it was, no matter what was learned later.
 */
export const ContractDeltaSchema = z
  .object({
    knowledge: ProjectKnowledgeSchema.optional(),
    endpoints: z.array(EndpointSchema).optional(),
    modules: z.array(ModuleSchema).optional(),
    mounts: z.array(MountSchema).optional(),
  })
  .strict();

export type ContractBody = z.infer<typeof ContractBodySchema>;
export type ContractInput = ContractBody;
export type ContractDelta = z.infer<typeof ContractDeltaSchema>;
export type Endpoint = z.infer<typeof EndpointSchema>;
export type ContractModule = z.infer<typeof ModuleSchema>;
export type Mount = z.infer<typeof MountSchema>;
type Check = z.infer<typeof CheckSchema>;

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

/**
 * Trailing punctuation a sentence leaves on a path captured from prose (Run-10
 * blocker #4): a brief reading "...validates the request body for POST
 * /api/register. Requirements: ..." lets the explicit-endpoint regex's path char
 * class — which must accept a literal `.` for genuine path syntax (a file
 * extension "/files/report.pdf", a version segment "/v1.2/items") — capture the
 * sentence-ending period too, minting a permanent phantom ref distinct from the
 * real endpoint. Stripped ONLY from the end of the whole path (see below), so an
 * internal dot with alphanumerics on both sides never qualifies: it is never the
 * last character, so this pattern never sees it.
 */
const TRAILING_SENTENCE_PUNCTUATION = /[.,;:!?]+$/;

/**
 * The canonical normal form of an endpoint PATH (Run-10 blocker #2). Every contract
 * writer — spec-derivation ({id}), decomposition-derived fragments (:id from task
 * text), the completion amend (deriveEndpoints, from real route code), and the bulk
 * path — and the merge's divergence check normalize through THIS one function, so
 * two spellings of the SAME endpoint are never mistaken for an `endpoint-divergence`
 * conflict. Normalizes:
 *  - param placeholders: OpenAPI `{id}` and Express `:id` BOTH become `:id` (the
 *    served-route convention), so "/api/todos/{id}" and "/api/todos/:id" are equal;
 *  - a trailing slash is stripped (except the root "/"); e.g. "/api/todos/" → "/api/todos";
 *  - duplicate slashes are collapsed; a missing leading slash is added;
 *  - trailing sentence punctuation is stripped from the LAST segment only (Run-10
 *    blocker #4), e.g. "/api/register." → "/api/register" — but "/files/report.pdf"
 *    and "/v1.2/items" are untouched, since neither ends in punctuation.
 * Idempotent: normalizePath(normalizePath(p)) === normalizePath(p). It canonicalizes
 * SYNTAX only — it never changes which segments are params or their names, so a
 * genuinely different path (e.g. a lost param segment) stays different and still
 * surfaces as a real conflict.
 */
export function normalizePath(path: string): string {
  let p = path.trim();
  if (p.length === 0) return "/";
  p = p.replace(/\{([^/{}]+)\}/g, ":$1"); // {name} -> :name
  p = p.replace(/\/{2,}/g, "/"); // collapse duplicate slashes
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1); // strip trailing slash (not root)

  if (p.length > 1) {
    const lastSlash = p.lastIndexOf("/");
    const lastSegment = p.slice(lastSlash + 1);
    const stripped = lastSegment.replace(TRAILING_SENTENCE_PUNCTUATION, "");
    // Only apply if something was actually stripped and a non-empty segment
    // remains — never let this branch produce a degenerate empty last segment.
    if (stripped.length > 0 && stripped.length < lastSegment.length) {
      p = p.slice(0, lastSlash + 1) + stripped;
    }
  }
  return p;
}

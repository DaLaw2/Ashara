import type { WorkItemId } from "@ashara/shared";
import { normalizePath } from "@ashara/shared";
import type { ContractInput, ContractDelta, Endpoint, ContractModule } from "@ashara/shared";

/**
 * Derives ProjectContract fragments (ADR-028, mig-phase-9) from what decomposition
 * already planned — task titles/descriptions and story/feature intent text — with
 * zero new LLM calls. Every function here is pure and total: no repository, no
 * network, deterministic regex/parse over text the decomposer already produced.
 *
 * Two extraction paths feed the endpoint list:
 *  1. EXPLICIT — a task's own text names a method + path (e.g. "Create POST
 *     /api/register endpoint..." — the Task Quality Requirements prompt in
 *     decomposition.ts asks for exactly this phrasing).
 *  2. INTENT — the decomposed-from item's OWN text (story/feature title +
 *     description, not a task) names an intent this system already knows tends
 *     to get planned as prose but not as a dedicated task (Run 9's register-gap,
 *     R8-F4/e2e-run9-report.md: the story said "user registration" but no task
 *     ever became "POST /api/register", so the endpoint was silently unplanned).
 *     Intent-only entries are seeded ONLY when no explicit entry already claims
 *     the same logical ref — explicit findings are always more precise and win.
 *
 * `ref` is a stable resource+action slug (e.g. "register.create", "todos.list")
 * derived structurally from method + path so the SAME logical endpoint always
 * produces the SAME ref regardless of which extraction path found it — this is
 * what lets the intent-derived register endpoint merge into (rather than
 * conflict with) an explicit one if a later story ever declares it directly.
 */

type HttpMethod = Endpoint["method"];

// The path char class includes both `:` (Express `:id`) and `{}` (OpenAPI `{id}`)
// so a task written either way keeps its param segment; normalizePath then unifies
// the two spellings (Run-10 blocker #2). The capture requires its LAST character to
// come from a class WITHOUT `.` (falling back to a bare `/`), so a sentence-ending
// period after the path ("...for POST /api/register. Requirements: ...") is never
// swallowed into the match at the source (Run-10 blocker #4) — normalizePath is a
// second line of defense for any caller that skips this regex entirely. A genuine
// internal dot (a file extension, a version segment) is unaffected: it is never the
// last character of a longer path, so it is captured by the `*` before it.
const EXPLICIT_ENDPOINT_PATTERN = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[\w/:.{}-]*[\w/:{}-]|\/)/g;

/** Requires a file extension so a URL path fragment is never mistaken for a module path. */
const MODULE_PATH_PATTERN = /\b(?:[\w@-]+\/)+[\w-]+\.\w{1,5}\b/g;

const PARAM_SEGMENT_PATTERN = /^:|^\{.*\}$|^[0-9]+$/;

export interface DerivedTextSource {
  readonly title: string;
  readonly description: string;
}

export interface DerivedTask extends DerivedTextSource {
  readonly id: WorkItemId;
}

export interface DerivedContractFragment {
  readonly endpoints: Endpoint[];
  readonly modules: ContractModule[];
}

function actionForMethod(method: HttpMethod, hasTrailingParam: boolean): string {
  switch (method) {
    case "GET":
      return hasTrailingParam ? "get" : "list";
    case "POST":
      return "create";
    case "PUT":
    case "PATCH":
      return hasTrailingParam ? "update" : "replace";
    case "DELETE":
      return "delete";
    default:
      return method.toLowerCase();
  }
}

/**
 * Structural resource+action naming (Rails-style resourceful routing): the ref
 * depends only on the path's resource segments and what the method+trailing-param
 * shape imply about the action, never on the exact literal path text. This is
 * what makes an intent-derived default (e.g. POST /api/register) and a later
 * explicit declaration of the same logical endpoint collapse onto one ref
 * instead of accumulating as unrelated entries.
 */
export function deriveEndpointRef(method: HttpMethod, path: string): string {
  const segments = normalizePath(path)
    .replace(/^\//, "")
    .replace(/^api\//i, "")
    .split("/")
    .filter((s) => s.length > 0);

  if (segments.length === 0) {
    return method.toLowerCase();
  }

  const hasTrailingParam = segments.length > 1 && PARAM_SEGMENT_PATTERN.test(segments[segments.length - 1]!);
  const resourceSegments = hasTrailingParam ? segments.slice(0, -1) : segments;
  const resource = resourceSegments.join(".").toLowerCase();

  return `${resource}.${actionForMethod(method, hasTrailingParam)}`;
}

/**
 * Grouping/namespace path segments that carry NO feature identity of their own —
 * a REST convention prefix that buckets several unrelated features under one URL
 * space (e.g. "/api/auth/login" is the login feature grouped under "auth", not a
 * distinct "auth.login" resource). Deliberately narrow (ADR-031: evidence-driven):
 * `auth` is the ONE prefix the Run-11 dual-namespace schism demonstrated
 * (POST /api/login vs POST /api/auth/login re-declared as two features). Grow this
 * set only when a new run demonstrates the same schism for a different prefix.
 */
const GROUPING_PREFIX_SEGMENTS = new Set(["auth"]);

/** Strips `/api`, then leading grouping prefixes, leaving the feature's own segments. */
function featureSegments(path: string): string[] {
  const segments = normalizePath(path)
    .replace(/^\//, "")
    .replace(/^api\//i, "")
    .split("/")
    .filter((s) => s.length > 0);
  // Drop leading grouping segments ONLY while a real resource segment still
  // follows, so an endpoint whose own resource IS "auth" (no following segment)
  // is never emptied out.
  let start = 0;
  while (start < segments.length - 1 && GROUPING_PREFIX_SEGMENTS.has(segments[start]!.toLowerCase())) {
    start += 1;
  }
  return segments.slice(start);
}

/**
 * The endpoint's FEATURE identity — a COARSER key than `deriveEndpointRef` that
 * collapses well-known grouping prefixes (see GROUPING_PREFIX_SEGMENTS). Where
 * `deriveEndpointRef` keeps `auth` as a resource segment ("auth.login.create"),
 * this yields the same key ("login.create") for BOTH "/api/login" and
 * "/api/auth/login", so a feature declared under two path namespaces resolves to
 * one identity. This is the Run-11 schism fix: dedup by feature, not path string.
 */
export function deriveEndpointFeatureKey(method: HttpMethod, path: string): string {
  const effective = featureSegments(path);
  if (effective.length === 0) return method.toLowerCase();
  return deriveEndpointRef(method, `/${effective.join("/")}`);
}

/**
 * Whether the path carries a grouping/namespace prefix (see
 * GROUPING_PREFIX_SEGMENTS) ahead of its own resource — e.g. "/api/auth/logout"
 * (grouped under "auth") does, "/api/register" does not. Out-of-scope gating
 * (coverage-reconciliation) applies ONLY to grouped endpoints, because Run-11's
 * spec-derivation over-enumeration (logout/refresh/me) all appeared under the
 * `auth` grouping — a top-level resource declaration is the legitimate Run-9
 * register-recovery and is never gated.
 */
export function endpointHasGroupingPrefix(path: string): boolean {
  const rawLen = normalizePath(path)
    .replace(/^\//, "")
    .replace(/^api\//i, "")
    .split("/")
    .filter((s) => s.length > 0).length;
  return rawLen > featureSegments(path).length;
}

/**
 * The endpoint's RESOURCE identity — feature key without the method/action, and
 * without a trailing param segment. "/api/todos", "/api/todos/:id" and
 * "GET /api/todos" all resolve to "todos"; "/api/auth/logout" resolves to
 * "logout". Used to decide whether an unplanned endpoint is GROUNDED in the plan:
 * an endpoint whose resource is already represented by a planned/built endpoint is
 * in-scope (a legitimate new action on a known resource), whereas one whose
 * resource appears nowhere in the plan or vision is out-of-scope (Run-11's
 * spec-derivation-invented logout/refresh/me class).
 */
export function deriveEndpointResourceKey(path: string): string {
  const effective = featureSegments(path);
  if (effective.length === 0) return "";
  const hasTrailingParam = effective.length > 1 && PARAM_SEGMENT_PATTERN.test(effective[effective.length - 1]!);
  const resourceSegments = hasTrailingParam ? effective.slice(0, -1) : effective;
  return resourceSegments.join(".").toLowerCase();
}

function extractExplicitEndpoints(text: string): Array<{ method: HttpMethod; path: string }> {
  const found: Array<{ method: HttpMethod; path: string }> = [];
  for (const match of text.matchAll(EXPLICIT_ENDPOINT_PATTERN)) {
    const method = match[1] as HttpMethod;
    const path = match[2]!;
    found.push({ method, path });
  }
  return found;
}

function deriveModulePaths(text: string): string[] {
  // Strip explicit endpoint mentions first so "POST /api/register" never lets
  // the module-path regex misread "api/register" as a source file path.
  const stripped = text.replace(EXPLICIT_ENDPOINT_PATTERN, " ");
  return [...new Set(stripped.match(MODULE_PATH_PATTERN) ?? [])];
}

/** A test/spec source file — a task whose file deliverables are ALL of this kind. */
const TEST_FILE_PATTERN = /\.(?:test|spec)\b|(?:^|\/)(?:tests?|__tests__|e2e)\//i;

/**
 * A task is TEST-ONLY (Run-10 blocker #2) when it names file paths and EVERY one is
 * a test/spec file. Such a task mentions endpoints it TESTS, not endpoints it
 * CREATES — deriving a contract endpoint from it wrongly redeclares a real endpoint
 * (the Run-10 divergence). A wrongly-declared endpoint is worse than a missed one:
 * spec-derivation and reconciliation cover a genuine miss, so we skip it. A task
 * that names no file paths is NOT treated as test-only (we cannot tell), so its
 * explicit endpoints are still derived.
 */
function isTestOnlyTask(modulePaths: readonly string[]): boolean {
  return modulePaths.length > 0 && modulePaths.every((p) => TEST_FILE_PATTERN.test(p));
}

/**
 * Derives the endpoint + module fragments a decomposed-from item (a story or
 * feature) and its emitted tasks imply. `intentSources` are text sources whose
 * INTENT (not just explicit method+path mentions) is scanned by the lexicon —
 * normally the decomposed-from story/feature itself.
 */
export function deriveContractFragment(
  intentSources: readonly DerivedTextSource[],
  tasks: readonly DerivedTask[],
): DerivedContractFragment {
  const endpoints: Endpoint[] = [];
  const modulesByPath = new Map<string, ContractModule>();
  const seenRefs = new Set<string>();

  for (const task of tasks) {
    const text = `${task.title} ${task.description}`;
    const modulePaths = deriveModulePaths(text);
    const testOnly = isTestOnlyTask(modulePaths);

    if (!testOnly) {
      for (const { method, path } of extractExplicitEndpoints(text)) {
        const ref = deriveEndpointRef(method, path);
        if (seenRefs.has(ref)) continue; // first explicit mention within this batch wins
        seenRefs.add(ref);
        endpoints.push({
          ref,
          method,
          path: normalizePath(path),
          purpose: task.description || task.title,
          declaredBy: task.id,
        });
      }
    }

    for (const modulePath of modulePaths) {
      if (!modulesByPath.has(modulePath)) {
        modulesByPath.set(modulePath, {
          path: modulePath,
          purpose: task.description || task.title,
          reuseOnly: false,
          providerWorkItem: task.id,
        });
      }
    }
  }

  return { endpoints, modules: [...modulesByPath.values()] };
}

/**
 * Shapes ONE completion-amend endpoint (Run-10 blocker #2). Delivery CONFIRMS
 * coverage; it never redefines the spec. So for an endpoint whose `ref` is ALREADY
 * declared in `existingEndpoints`, this echoes the DECLARED method+path verbatim
 * (only stamping `declaredBy` = the completing task) — the amend is then idempotent
 * and can never conflict, so the coverage signal always lands (fixing the Run-10
 * "sourceModule/declaredBy never set → gap falsely open forever"). A genuinely NEW
 * endpoint the delivery introduced is added with its normalized path. Pure/total.
 */
export function deriveCompletionEndpoint(
  existingEndpoints: readonly Endpoint[],
  delivered: { readonly method: HttpMethod; readonly path: string },
  taskId: string,
): Endpoint {
  const ref = deriveEndpointRef(delivered.method, delivered.path);
  const declared = existingEndpoints.find((e) => e.ref === ref);
  if (declared) {
    return { ref, method: declared.method, path: declared.path, purpose: declared.purpose, declaredBy: taskId };
  }
  return {
    ref,
    method: delivered.method,
    path: normalizePath(delivered.path),
    purpose: `Delivered by task ${taskId}`,
    declaredBy: taskId,
  };
}

/**
 * Shapes ONE completion-amend module (Run-10 blocker #5), mirroring
 * `deriveCompletionEndpoint` above. Delivery CONFIRMS a module now exists; it never
 * redefines the module's purpose. So for a module whose `path` is ALREADY registered
 * in `existingModules`, this echoes the DECLARED purpose verbatim (only stamping
 * `providerWorkItem` = the completing task) — the amend is then idempotent on
 * `purpose` and can never trip `module-purpose-divergence` (contract-merge.ts), so the
 * reuse/coverage signal always lands instead of being lost to a fail-soft skip. A
 * genuinely NEW module path is added with the generic completion purpose, as before.
 * Pure/total.
 */
export function deriveCompletionModule(
  existingModules: readonly ContractModule[],
  delivered: { readonly path: string },
  taskId: string,
): ContractModule {
  const declared = existingModules.find((m) => m.path === delivered.path);
  if (declared) {
    return { path: declared.path, purpose: declared.purpose, reuseOnly: true, providerWorkItem: taskId };
  }
  return {
    path: delivered.path,
    purpose: `Delivered by task ${taskId}`,
    reuseOnly: true,
    providerWorkItem: taskId,
  };
}

export function toContractDelta(fragment: DerivedContractFragment): ContractDelta {
  return { endpoints: fragment.endpoints, modules: fragment.modules };
}

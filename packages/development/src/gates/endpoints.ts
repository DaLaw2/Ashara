import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  computeReachableFiles,
  extractImportBindings,
  extractMounts,
  findEntryPoint,
  isSourceFile,
  resolveImportSpec,
} from "./internal.js";
import type { RouterMount } from "./internal.js";

// ---------------------------------------------------------------------------
// Endpoint derivation (smoke test) — statically enumerate concrete
// (method, path) pairs from route registrations in files reachable from the
// entry point, so the smoke test can probe every claimed endpoint instead of
// just GET /. Deterministic, text-level, no LLM.
// ---------------------------------------------------------------------------

export interface DerivedEndpoint {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
}

export interface EndpointDerivation {
  readonly endpoints: ReadonlyArray<DerivedEndpoint>;
  readonly notes: ReadonlyArray<string>;
}

const HTTP_METHOD_BY_NAME: ReadonlyMap<string, DerivedEndpoint["method"]> = new Map([
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["patch", "PATCH"],
  ["delete", "DELETE"],
]);

const APP_ENDPOINT_PATTERN = /\bapp\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]*)["'`]/g;
const ROUTER_ENDPOINT_PATTERN = /\brouter\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]*)["'`]/g;

function extractLiteralEndpoints(
  content: string,
  pattern: RegExp,
  notes: string[],
  fileLabel: string,
): DerivedEndpoint[] {
  const endpoints: DerivedEndpoint[] = [];
  for (const m of content.matchAll(pattern)) {
    const method = HTTP_METHOD_BY_NAME.get(m[1]);
    const path = m[2];
    if (method === undefined) continue;
    if (!path.startsWith("/") || path.includes("${")) {
      notes.push(`skipped non-literal route path "${path}" in ${fileLabel}`);
      continue;
    }
    endpoints.push({ method, path });
  }
  return endpoints;
}

function joinRoutePaths(prefix: string, subpath: string): string {
  const trimmedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const normalizedSub = subpath.startsWith("/") ? subpath : `/${subpath}`;
  const joined = `${trimmedPrefix}${normalizedSub}`;
  return joined.length === 0 ? "/" : joined;
}

export async function deriveEndpoints(
  projectPath: string,
  contractEntryPoint: string | null = null,
  _contractLanguage: string | null = null,
): Promise<EndpointDerivation> {
  const projectRoot = resolve(projectPath);
  const notes: string[] = [];

  const entryPoint = await findEntryPoint(projectRoot, contractEntryPoint);
  if (entryPoint === null) {
    return { endpoints: [], notes: ["no entry point found — cannot derive endpoints"] };
  }

  interface ParsedFile {
    readonly file: string;
    readonly appEndpoints: DerivedEndpoint[];
    readonly routerEndpoints: DerivedEndpoint[];
    readonly mounts: ReadonlyArray<RouterMount>;
    readonly bindings: ReadonlyMap<string, string>;
  }

  const parsedFiles: ParsedFile[] = [];
  for (const file of await computeReachableFiles(entryPoint)) {
    if (!isSourceFile(file)) continue;
    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    const fileLabel = relative(projectRoot, file);
    parsedFiles.push({
      file,
      appEndpoints: extractLiteralEndpoints(content, APP_ENDPOINT_PATTERN, notes, fileLabel),
      routerEndpoints: extractLiteralEndpoints(content, ROUTER_ENDPOINT_PATTERN, notes, fileLabel),
      mounts: extractMounts(content),
      bindings: extractImportBindings(content),
    });
  }

  // Resolve each app.use(prefix, <identifier>) to the file the identifier is
  // imported from — that file's router endpoints live under the prefix.
  const mountPrefixesByFile = new Map<string, Set<string>>();
  for (const parsed of parsedFiles) {
    for (const mount of parsed.mounts) {
      const spec = parsed.bindings.get(mount.identifier);
      if (spec === undefined || !(spec.startsWith("./") || spec.startsWith("../"))) continue;
      for (const resolvedFile of await resolveImportSpec(parsed.file, spec)) {
        let prefixes = mountPrefixesByFile.get(resolvedFile);
        if (prefixes === undefined) {
          prefixes = new Set<string>();
          mountPrefixesByFile.set(resolvedFile, prefixes);
        }
        prefixes.add(mount.prefix);
      }
    }
  }

  const endpoints: DerivedEndpoint[] = [];
  for (const parsed of parsedFiles) {
    endpoints.push(...parsed.appEndpoints);
    if (parsed.routerEndpoints.length === 0) continue;
    const prefixes = mountPrefixesByFile.get(parsed.file);
    if (prefixes !== undefined && prefixes.size > 0) {
      for (const prefix of prefixes) {
        for (const endpoint of parsed.routerEndpoints) {
          endpoints.push({ method: endpoint.method, path: joinRoutePaths(prefix, endpoint.path) });
        }
      }
    } else {
      // Best effort — never fail silently: probe the router's subpaths under
      // "/" so an imported-but-unmounted router still surfaces as 404s.
      notes.push(
        `mount prefix for ${relative(projectRoot, parsed.file)} not statically resolvable — probing its subpaths under "/"`,
      );
      endpoints.push(...parsed.routerEndpoints);
    }
  }

  const seen = new Set<string>();
  const deduped: DerivedEndpoint[] = [];
  for (const endpoint of endpoints) {
    const key = `${endpoint.method} ${endpoint.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(endpoint);
    }
  }

  return { endpoints: deduped, notes };
}

import type { RawFailureContext } from "../failure-router.js";

const HTTP_METHODS = "GET|POST|PUT|DELETE|PATCH|HEAD";

// "GET /path -> 404 (expected 302)" — check-runner output format
const CHECK_RESULT_PATTERN = new RegExp(
  `(${HTTP_METHODS}) (\/\\S+) -> \\d{3} \\(expected (\\d{3}|\\dxx)\\)`,
  "g",
);

// "GET /:code returned 404" or "GET /:code → 404" — narrative failure descriptions
const NARRATIVE_PATTERN = new RegExp(
  `(${HTTP_METHODS}) (\/\\S+)\\s+(?:returned|→)\\s+\\d{3}`,
  "g",
);

function extractHttpFailures(text: string): Array<{ method: string; path: string; expected: string }> {
  const results: Array<{ method: string; path: string; expected: string }> = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(CHECK_RESULT_PATTERN)) {
    const key = `${match[1]} ${match[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ method: match[1], path: match[2], expected: match[3] });
    }
  }

  for (const match of text.matchAll(NARRATIVE_PATTERN)) {
    const key = `${match[1]} ${match[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ method: match[1], path: match[2], expected: "2xx" });
    }
  }

  return results;
}

function collectSearchableText(failure: RawFailureContext): string {
  const parts: string[] = [failure.detail];

  if (typeof failure.raw.summary === "string") {
    parts.push(failure.raw.summary);
  }

  const chain = failure.raw.chain;
  if (chain && typeof chain === "object") {
    collectChainMessages(chain as Record<string, unknown>, parts);
  }

  const gateResults = failure.raw.gateResults;
  if (gateResults && typeof gateResults === "object") {
    collectCheckOutputs(gateResults as Record<string, unknown>, parts);
  }

  return parts.join("\n");
}

function collectChainMessages(layer: Record<string, unknown>, out: string[]): void {
  if (typeof layer.message === "string") out.push(layer.message);
  if (layer.context && typeof layer.context === "object") {
    for (const value of Object.values(layer.context as Record<string, unknown>)) {
      if (typeof value === "string") out.push(value);
    }
  }
  if (layer.cause && typeof layer.cause === "object") {
    collectChainMessages(layer.cause as Record<string, unknown>, out);
  }
}

function collectCheckOutputs(gateResults: Record<string, unknown>, out: string[]): void {
  for (const gate of Object.values(gateResults)) {
    if (!gate || typeof gate !== "object") continue;
    const tierHolder = gate as Record<string, unknown>;
    const tier = tierHolder.tier ?? tierHolder;
    if (!tier || typeof tier !== "object") continue;
    const checks = (tier as Record<string, unknown>).checks;
    if (!Array.isArray(checks)) continue;
    for (const check of checks) {
      if (!check || typeof check !== "object") continue;
      const c = check as Record<string, unknown>;
      if (c.passed === false && typeof c.output === "string") {
        out.push(c.output);
      }
      if (c.passed === false && typeof c.name === "string") {
        out.push(c.name);
      }
    }
  }
}

function toHttpCheck(method: string, path: string, expected: string): string {
  return `${method} ${path} returns ${expected}`;
}

function toDeliverable(method: string, path: string, expected: string): string {
  return `Route ${method} ${path} must be mounted and respond with HTTP ${expected}`;
}

export function deriveRetryChecks(
  failure: RawFailureContext,
  existingChecks: readonly string[],
): string[] {
  const text = collectSearchableText(failure);
  const failures = extractHttpFailures(text);
  if (failures.length === 0) return [...existingChecks];

  const existing = new Set(existingChecks);
  const merged = [...existingChecks];

  for (const f of failures) {
    const check = toHttpCheck(f.method, f.path, f.expected);
    if (!existing.has(check)) {
      existing.add(check);
      merged.push(check);
    }
  }

  return merged;
}

export function deriveRetryDeliverables(
  failure: RawFailureContext,
  existingDeliverables: readonly string[],
): string[] {
  const text = collectSearchableText(failure);
  const failures = extractHttpFailures(text);
  if (failures.length === 0) return [...existingDeliverables];

  const existing = new Set(existingDeliverables);
  const merged = [...existingDeliverables];

  for (const f of failures) {
    const deliverable = toDeliverable(f.method, f.path, f.expected);
    if (!existing.has(deliverable)) {
      existing.add(deliverable);
      merged.push(deliverable);
    }
  }

  return merged;
}

export type ProjectId = string & { readonly __brand: "ProjectId" };
export type WorkItemId = string & { readonly __brand: "WorkItemId" };
export type SessionId = string & { readonly __brand: "SessionId" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// CI PROBE: explicit any to test eslint gate
export function eslintProbe(x: any): void { console.log(x); }

/**
 * Validated narrowing of an external string into a branded `ProjectId` (used at
 * the contract read boundary, ADR-028). Rejects anything that is not a UUID so
 * the brand is never assumed without validation. Mirrors the parse* helpers in
 * enums.ts.
 */
export function parseProjectId(raw: string): ProjectId {
  if (!UUID_PATTERN.test(raw)) {
    throw new Error(`Invalid ProjectId "${raw}": expected a UUID`);
  }
  return raw as ProjectId;
}

export function parseWorkItemId(raw: string): WorkItemId {
  if (!UUID_PATTERN.test(raw)) {
    throw new Error(`Invalid WorkItemId "${raw}": expected a UUID`);
  }
  return raw as WorkItemId;
}

export function createWorkItemId(): WorkItemId {
  return crypto.randomUUID() as WorkItemId;
}

export function createSessionId(): SessionId {
  return crypto.randomUUID() as SessionId;
}

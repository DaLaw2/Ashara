export type ProjectId = string & { readonly __brand: "ProjectId" };
export type WorkItemId = string & { readonly __brand: "WorkItemId" };
export type SessionId = string & { readonly __brand: "SessionId" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class InvalidProjectId extends Error {
  constructor(readonly raw: string) {
    super(`Invalid ProjectId "${raw}": expected a UUID`);
    this.name = "InvalidProjectId";
  }
}

/**
 * Validated narrowing of an external string into a branded `ProjectId` — a
 * projects.id (migration 014), the key of a project's visions, work items and
 * contract. Rejects anything that is not a UUID so the brand is never assumed
 * without validation. Mirrors the parse* helpers in enums.ts.
 */
export function parseProjectId(raw: string): ProjectId {
  if (!UUID_PATTERN.test(raw)) {
    throw new InvalidProjectId(raw);
  }
  return raw as ProjectId;
}

export class InvalidWorkItemId extends Error {
  constructor(readonly raw: string) {
    super(`Invalid WorkItemId "${raw}": expected a UUID`);
    this.name = "InvalidWorkItemId";
  }
}

/** Validated narrowing of a stored work_items.id reference (e.g. a check task's id) into a `WorkItemId`. */
export function parseWorkItemId(raw: string): WorkItemId {
  if (!UUID_PATTERN.test(raw)) {
    throw new InvalidWorkItemId(raw);
  }
  return raw as WorkItemId;
}

export function createWorkItemId(): WorkItemId {
  return crypto.randomUUID() as WorkItemId;
}

export function createSessionId(): SessionId {
  return crypto.randomUUID() as SessionId;
}

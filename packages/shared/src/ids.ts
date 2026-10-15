import { z } from "zod";

export type ProjectId = string & { readonly __brand: "ProjectId" };
export type WorkItemId = string & { readonly __brand: "WorkItemId" };
export type SessionId = string & { readonly __brand: "SessionId" };

type IdBrand = "ProjectId" | "WorkItemId" | "SessionId";

// All three are uuid columns (projects.id, work_items.id, dev_sessions.id) or
// crypto.randomUUID(). z.guid() is the 8-4-4-4-12 hex shape without RFC 9562
// version bits: Postgres stores any such value in a uuid column.
const UuidSchema = z.guid();

/**
 * A value that was to become a branded id and is not one. `field` names where
 * it came from (a column, a route param, a CLI flag, a model output field), so
 * the message alone locates the bad input.
 */
export class InvalidId extends Error {
  constructor(
    readonly brand: IdBrand,
    readonly field: string,
    readonly raw: unknown,
  ) {
    super(`Invalid ${brand} in ${field}: expected a UUID, got ${JSON.stringify(raw) ?? String(raw)}`);
    this.name = "InvalidId";
  }
}

function parseUuid(brand: IdBrand, raw: unknown, field: string): string {
  const parsed = UuidSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidId(brand, field, raw);
  return parsed.data;
}

/**
 * The one way an external value becomes a `ProjectId` — a projects.id
 * (migration 014), the key of a project's visions and work items.
 */
export function parseProjectId(raw: unknown, field: string): ProjectId {
  return parseUuid("ProjectId", raw, field) as ProjectId;
}

/** The one way an external value becomes a `WorkItemId` — a work_items.id or a stored reference to one. */
export function parseWorkItemId(raw: unknown, field: string): WorkItemId {
  return parseUuid("WorkItemId", raw, field) as WorkItemId;
}

export function createWorkItemId(): WorkItemId {
  return parseWorkItemId(crypto.randomUUID(), "crypto.randomUUID()");
}

export function createSessionId(): SessionId {
  return parseUuid("SessionId", crypto.randomUUID(), "crypto.randomUUID()") as SessionId;
}

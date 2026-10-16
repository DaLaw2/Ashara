import { z } from "zod";

type IdBrand = "ProjectId" | "WorkItemId";

// Both are uuid columns (projects.id, work_items.id) or
// crypto.randomUUID(). z.guid() is the 8-4-4-4-12 hex shape without RFC 9562
// version bits: Postgres stores any such value in a uuid column. The brand is
// Zod's, so the only value that carries it is one the schema accepted.
const ProjectIdSchema = z.guid().brand<"ProjectId">();
const WorkItemIdSchema = z.guid().brand<"WorkItemId">();

export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type WorkItemId = z.infer<typeof WorkItemIdSchema>;

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

function parseUuid<S extends z.ZodType>(brand: IdBrand, schema: S, raw: unknown, field: string): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new InvalidId(brand, field, raw);
  return parsed.data;
}

/**
 * The one way an external value becomes a `ProjectId` — a projects.id
 * (migration 014), the key of a project's visions and work items.
 */
export function parseProjectId(raw: unknown, field: string): ProjectId {
  return parseUuid("ProjectId", ProjectIdSchema, raw, field);
}

/** The one way an external value becomes a `WorkItemId` — a work_items.id or a stored reference to one. */
export function parseWorkItemId(raw: unknown, field: string): WorkItemId {
  return parseUuid("WorkItemId", WorkItemIdSchema, raw, field);
}

export function createWorkItemId(): WorkItemId {
  return parseWorkItemId(crypto.randomUUID(), "crypto.randomUUID()");
}

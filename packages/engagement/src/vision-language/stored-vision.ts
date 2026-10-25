import { Column, is, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { z } from "zod";
import { qualifiedColumn } from "@ashara/db";

// Engagement's published reads of a project's vision versions (vision_documents) for a context that
// admits or plans a project by them inside its own statement: whether the project has a vision, which
// version is in force, and that version or a numbered one as stored. Each is spelled here once; a reader imports it
// (`@ashara/engagement/vision`) instead of querying the table.

/** A column named with its table, so a subquery never reads it as one of its own; an expression as written. */
const named = (ref: AnyColumn | SQL): SQL => (is(ref, Column) ? qualifiedColumn(ref) : ref);

/** The project has a vision version on record. */
export const hasVision = (projectId: AnyColumn | SQL): SQL => sql`EXISTS (SELECT 1 FROM vision_documents hv WHERE hv.project_id = ${named(projectId)})`;

/** The number of the project's vision version in force, a scalar subquery: null when it has none. */
export const currentVisionVersion = (projectId: AnyColumn | SQL): SQL<unknown> =>
  sql<unknown>`(SELECT max(cv.version) FROM vision_documents cv WHERE cv.project_id = ${named(projectId)})`;

/** A vision_documents row `sv` as one jsonb object, the shape parseStoredVision reads. */
const STORED_VISION_OBJECT = sql.raw(`jsonb_build_object(
      'projectId', sv.project_id, 'version', sv.version, 'visionText', sv.vision_text, 'summary', sv.summary,
      'scopeBoundaries', sv.scope_boundaries, 'inferences', sv.inferences, 'openQuestions', sv.open_questions,
      'contractForm', sv.contract_form, 'interface', sv.interface, 'guarantees', sv.guarantees, 'exclusions', sv.exclusions)`);

/**
 * The project's vision version in force as stored, its jsonb unread, a scalar subquery of one jsonb
 * object (null when it has none) that parseStoredVision reads.
 */
export const currentStoredVision = (projectId: AnyColumn | SQL): SQL<unknown> =>
  sql<unknown>`(SELECT ${STORED_VISION_OBJECT} FROM vision_documents sv WHERE sv.project_id = ${named(projectId)} ORDER BY sv.version DESC LIMIT 1)`;

/**
 * The project's vision version `version` as stored, its jsonb unread, a scalar subquery of one jsonb
 * object (null when the project has no such version) that parseStoredVision reads.
 */
export const storedVisionVersion = (projectId: AnyColumn | SQL, version: number): SQL<unknown> =>
  sql<unknown>`(SELECT ${STORED_VISION_OBJECT} FROM vision_documents sv WHERE sv.project_id = ${named(projectId)} AND sv.version = ${version})`;

const StoredVisionSchema = z.strictObject({
  projectId: z.string().min(1),
  version: z.number().int().positive(),
  visionText: z.string(),
  summary: z.string(),
  scopeBoundaries: z.unknown(),
  inferences: z.unknown(),
  openQuestions: z.unknown(),
  contractForm: z.unknown(),
  interface: z.unknown(),
  guarantees: z.unknown(),
  exclusions: z.unknown(),
});

/** A vision version as vision_documents stores it, its jsonb unread, as currentStoredVision reads it; parseStoredVision holds it to StoredVisionSchema's output. */
export interface StoredVision {
  readonly projectId: string;
  readonly version: number;
  readonly visionText: string;
  readonly summary: string;
  readonly scopeBoundaries: unknown;
  readonly inferences: unknown;
  readonly openQuestions: unknown;
  readonly contractForm: unknown;
  readonly interface: unknown;
  readonly guarantees: unknown;
  readonly exclusions: unknown;
}

/** What currentStoredVision read does not hold together as a stored vision version. */
class StoredVisionUnreadable extends Error {
  constructor(
    readonly projectId: string,
    readonly detail: string,
  ) {
    super(`project ${projectId}: its vision in force does not read as a stored vision version: ${detail}`);
    this.name = "StoredVisionUnreadable";
  }
}

/**
 * `A` when the checker finds it identical to `B`, else never: a field either one adds, drops, or
 * makes optional or readonly leaves nothing to assign, which mutual assignability misses for an
 * optional field.
 */
type Exactly<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? A : never;

/** Reads what currentStoredVision selected for the project; one that is absent or does not parse throws. */
export function parseStoredVision(projectId: string, raw: unknown): StoredVision {
  const parsed = StoredVisionSchema.safeParse(raw);
  if (!parsed.success) throw new StoredVisionUnreadable(projectId, z.prettifyError(parsed.error));
  const read: Exactly<Readonly<z.output<typeof StoredVisionSchema>>, StoredVision> = parsed.data;
  return read;
}

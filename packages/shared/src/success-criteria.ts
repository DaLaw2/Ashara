import { z } from "zod";

/**
 * Published Language: the persisted success_criteria array on work items.
 * Every element is a string — decomposition engines produce string criteria,
 * and every consumer reads them as strings. The domain type was `unknown[]`
 * historically; this schema catches non-string elements at the boundary
 * rather than letting them silently survive to a consumer cast.
 */
export const storedSuccessCriteriaSchema = z.array(z.string());

export type StoredSuccessCriteria = z.infer<typeof storedSuccessCriteriaSchema>;

/** Typed failure for a success_criteria jsonb value that is present but unreadable. */
export class SuccessCriteriaCorrupt extends Error {
  constructor(
    public readonly raw: unknown,
    public readonly detail: string,
  ) {
    super(`stored success_criteria is not a valid array (${detail})`);
    this.name = "SuccessCriteriaCorrupt";
  }
}

/**
 * Parses a jsonb value from the `success_criteria` column. Returns `undefined`
 * for null/undefined — absent successCriteria is a policy default (epics,
 * HTTP-created tasks, and tasks at levels that do not carry criteria all
 * legitimately omit it; every consumer has a deliberate fallback for the
 * absent case). THROWS on a non-null value that cannot be validated
 * (Discipline A).
 */
export function parseStoredSuccessCriteria(raw: unknown): StoredSuccessCriteria | undefined {
  if (raw === null || raw === undefined) return undefined;
  const result = storedSuccessCriteriaSchema.safeParse(raw);
  if (!result.success) {
    throw new SuccessCriteriaCorrupt(
      raw,
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return result.data;
}

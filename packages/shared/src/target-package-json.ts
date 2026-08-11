import { z } from "zod";

/**
 * Zod schema for the subset of package.json fields Ashara reads from a target
 * project. `.passthrough()` preserves unknown keys so the parsed value is a
 * faithful superset of what the file contained — callers that access fields
 * outside the schema still get them (as `unknown`), they just lose the
 * type-narrowing the schema provides for the known subset.
 *
 * Only the runtime schema is exported. Callers that need the inferred type
 * inline `z.infer<typeof TargetPackageJsonSchema>` — exporting a standalone
 * type alias with zero production consumers is a Discipline D / knip violation.
 */
export const TargetPackageJsonSchema = z
  .object({
    name: z.string().optional(),
    main: z.string().optional(),
    scripts: z.record(z.string(), z.unknown()).optional(),
    dependencies: z.record(z.string(), z.unknown()).optional(),
    devDependencies: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

import { z } from "zod";
import { buildContextFields, parseEnvironmentFile, readEnvironmentFile, refineBuildContext } from "@ashara/execution-infra";
import type { EnvironmentDefinitionField } from "@ashara/workplace";

// The platform role's environment definition as Quality reads it: the
// build context Execution Infrastructure builds the image from, and the product's commands Quality
// runs (`probe` on environment work, `build` and `test` on every merge). One parse of the whole file.

const command = z.string().refine((text) => text.trim() !== "", "must be a non-empty command");

/** Every key of the definition; the platform role's brief (Workplace) states a rule for each one. */
const definitionFields = {
  containerfile: buildContextFields.containerfile,
  recipe: buildContextFields.recipe,
  inputs: buildContextFields.inputs,
  probe: command,
  build: command,
  test: command,
} satisfies Record<EnvironmentDefinitionField, z.ZodType>;

const definitionSchema = z.object(definitionFields).strict().superRefine(refineBuildContext);

/**
 * The project's environment as the platform role commits it. Ashara never interprets it: the
 * commands are the project's, run as given; nothing is defaulted or inferred.
 */
export type EnvironmentDefinition = z.infer<typeof definitionSchema>;

/** Parses `environment/environment.toml` text. `source` names where it was read from, for the error. */
export function parseEnvironmentDefinition(text: string, source: string): EnvironmentDefinition {
  return parseEnvironmentFile(text, source, definitionSchema);
}

/** Reads and parses the definition as committed at `commit` (never from a work tree). */
export function readEnvironmentDefinition(gitDir: string, commit: string): Promise<EnvironmentDefinition> {
  return readEnvironmentFile(gitDir, commit, definitionSchema);
}

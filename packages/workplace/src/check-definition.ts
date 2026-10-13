/** One check the check author defines: a command the project environment runs; exit 0 with output means it passes. */
export interface CheckDefinition {
  readonly name: string;
  readonly command: string;
}

export type CheckDefinitionResult =
  | { readonly kind: "recorded"; readonly defined: number }
  /** The model can fix it: the reason is told to it as the tool's error. */
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Z0's side of define_check, supplied by the execution service for a check task only: it keeps
 * each definition for Z0 to harvest when the attempt finishes. The tool runs nothing.
 */
export interface CheckDefinitionPort {
  define(check: CheckDefinition): CheckDefinitionResult;
}

import type { ElidedText } from "@ashara/shared";

/** One of the definition's commands (`probe`, `build` or `test`), run in a cell from the built image. */
export interface EnvironmentTestRun {
  readonly command: string;
  /** null when the host had to kill the podman client (timedOut is then true) or the command's exit status was lost in the cell. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Each stream with its middle cut to a bound; every cut is counted. */
  readonly stdout: ElidedText;
  readonly stderr: ElidedText;
}

/**
 * What a check of the environment definition found. A definition, scope, image build or probe that
 * fails is a report, never a throw: it is the environment role's work, which the model can fix. A
 * substrate that cannot run the check throws instead.
 */
export type EnvironmentCheckReport =
  /** The definition is absent, unreadable or invalid, or its build context cannot be versioned. */
  | { readonly kind: "definition_refused"; readonly detail: string }
  /** The work adds, changes or deletes paths outside the recipe. */
  | { readonly kind: "out_of_scope"; readonly recipe: readonly string[]; readonly paths: readonly string[] }
  | { readonly kind: "build_failed"; readonly version: string; readonly detail: string; readonly log: ElidedText }
  | {
      readonly kind: "tested";
      readonly version: string;
      readonly imageRef: string;
      readonly build: { readonly kind: "reused" } | { readonly kind: "built"; readonly log: ElidedText };
      readonly probe: EnvironmentTestRun;
    };

/**
 * What an attempt's cell was started from: the BaseCell (only the task that defines the
 * environment runs on it) or the image of the project's environment version.
 */
export type AttemptCellImage =
  | { readonly kind: "base-cell"; readonly image: string; readonly digest: string }
  | {
      readonly kind: "environment";
      readonly version: string;
      readonly commit: string;
      readonly imageId: string;
      readonly imageRef: string;
    };

import { ENVIRONMENT_DEFINITION_PATH, ENVIRONMENT_DIR } from "@ashara/execution-infra";

/** Every key of the environment definition; Quality's schema of the file has exactly these. */
export type EnvironmentDefinitionField = "containerfile" | "recipe" | "inputs" | "probe" | "build" | "test";

/** The rule of each field, as the platform role's brief states it. */
const DEFINITION_FIELD_RULES: Readonly<Record<EnvironmentDefinitionField, string>> = {
  containerfile: `path of the container build file, a file under ${JSON.stringify(ENVIRONMENT_DIR)}. It is part of the recipe.`,
  recipe:
    `array of the other files under ${JSON.stringify(ENVIRONMENT_DIR)} the image build reads (scripts, configuration), ` +
    `possibly empty. The recipe is ${ENVIRONMENT_DEFINITION_PATH}, the containerfile and these files: only environment ` +
    `work may change them, and environment work may change nothing else.`,
  inputs:
    `array of product files the image build also reads, for example the product's dependency manifests, possibly ` +
    `empty. They are the product's: an input need not exist yet, and the build context holds only the recipe and the ` +
    `inputs that exist, so the containerfile must build while any input is still absent. Any task ` +
    `may change one, and a merge that changes one builds the image again and must pass the product's build, test and ` +
    `checks on it. Never name the product's source, its tests or its data here.`,
  probe:
    "shell command that proves the toolchain is present and runs; it must exit 0 within its time limit and print " +
    "non-empty output. It runs in a cell from the built image on a checkout that may hold no product at all, so it " +
    "must not build or test the product.",
  build:
    "shell command that builds the product from the repository root once the product exists; it must exit 0. It is " +
    "not run when the environment is defined: the product's first task sets up its layout so that it passes, and it " +
    "runs after every later merge.",
  test:
    "shell command that runs the product's tests from the repository root once the product exists; it must exit 0 and " +
    "print non-empty output. Like build, it is not run when the environment is defined.",
};

/**
 * The definition's schema and the rules Z0 holds environment work to, as the environment role's
 * brief states them: one rule per field of the definition, naming no stack.
 */
export function environmentDefinitionRules(): string {
  return [
    `# The environment definition`,
    `Write ${ENVIRONMENT_DEFINITION_PATH} as TOML with exactly these top-level keys, no table and no other key:`,
    ...Object.entries(DEFINITION_FIELD_RULES).map(([field, rule]) => `- ${field}: ${rule}`),
    ``,
    `What decides this work:`,
    `- Only recipe files may be added, changed or deleted; any other path in the work is refused. The product's`,
    `  code, its manifests, its tests and its data are the product's tasks' work, never part of the environment.`,
    `- The image is built from the recipe and the inputs that exist. Then probe runs in a cell from that image on a`,
    `  fresh checkout of the committed work. The gate passes only when the image builds and probe exits 0 within its`,
    `  time limit with non-empty output: stdout and stderr together must hold more than whitespace.`,
    `- The image build runs as root, but every cell from the image (the probe's, every task's, every check's) runs`,
    `  as a non-root user with HOME set to a writable, empty directory of the cell's own; the image's HOME is not`,
    `  used. So the recipe must not create, as root, a path the build, the tests or the tools later write (a cache, a`,
    `  temporary or output directory): leave it to the tools' defaults under HOME, or make it writable by any user.`,
  ].join("\n");
}

import { MANIFEST_FILE, RECIPE_DEFECT_TOKEN, TOOLCHAIN_TOKEN } from "../product.js";
import type { StandInContext } from "./context.js";
import type { ToolStep } from "./tool-steps.js";

/**
 * The platform role's turns: the environment definition and its Containerfile, built, with or without a recipe
 * defect.
 */
export function environmentWork(context: StandInContext): ToolStep[] {
  const defect = context.tape.chance("agent.recipe-defect", context.rates.recipeDefect, "environment");
  const definition = [
    'containerfile = "environment/Containerfile"',
    "recipe = []",
    `inputs = ${JSON.stringify([MANIFEST_FILE])}`,
    'probe = "sim probe"',
    'build = "sim build"',
    'test = "sim test"',
    "",
  ].join("\n");
  const containerfile = [
    "FROM scratch",
    `# sim: ${TOOLCHAIN_TOKEN}`,
    ...(defect ? [`# sim: ${RECIPE_DEFECT_TOKEN}`] : []),
    "",
  ].join("\n");
  return [
    ["write_file", { path: "environment/environment.toml", content: definition }],
    ["write_file", { path: "environment/Containerfile", content: containerfile }],
    ["build_environment", {}],
    [
      "finish",
      {
        status: "done",
        summary: "Defined the environment.",
        statement: "The simulated toolchain; the product is built with `sim build` and tested with `sim test`.",
      },
    ],
  ];
}

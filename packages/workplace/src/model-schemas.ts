import type { TurnToolSchema } from "@ashara/finance";
import { TOOL_PROFILES } from "./assignment.js";
import { toolSchemasFor } from "./tools.js";

/**
 * Every tool input schema an attempt can offer a model, keyed `<profile>/<tool>` (`+run_checks` when
 * the task's stored checks are supplied): what the integration schema-acceptance test judges against
 * every provider type, so a tool schema a provider refuses fails a test before any run sends it.
 */
export function offeredToolSchemas(): Readonly<Record<string, TurnToolSchema>> {
  const offered: Record<string, TurnToolSchema> = {};
  for (const profile of TOOL_PROFILES) {
    for (const runChecks of [false, true]) {
      for (const [name, schema] of Object.entries(toolSchemasFor(profile, runChecks))) {
        offered[`${profile}${runChecks ? "+run_checks" : ""}/${name}`] = schema;
      }
    }
  }
  return offered;
}

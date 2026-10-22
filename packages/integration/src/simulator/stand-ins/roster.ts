import type { StandInContext } from "./context.js";

/** The organization's roster as the stand-in drafts it: one role per capability, or a duplicate environment role. */
export function roster(context: StandInContext): unknown {
  const roles = [
    { name: "Liaison", responsibility: "Talks to the client.", capabilities: ["client-comms"] },
    { name: "Platform", responsibility: "Defines the environment.", capabilities: ["write-environment"] },
    { name: "Developer", responsibility: "Writes the product.", capabilities: ["write-source"] },
    { name: "QA", responsibility: "Writes the checks.", capabilities: ["author-checks"] },
  ];
  if (context.tape.chance("model.roster.duplicate-environment", context.rates.invalidOutput)) {
    return {
      roles: [
        ...roles,
        { name: "Platform 2", responsibility: "Also defines the environment.", capabilities: ["write-environment"] },
      ],
    };
  }
  return { roles };
}

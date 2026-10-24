/**
 * An optional member of a *Deps, *Port or *Config interface that no module the server's main reaches
 * supplies: a dependency no production path wires (scripts/optional-deps.ts).
 */

import { OPTIONAL_MEMBER_ALLOWLIST, findUnsuppliedOptionalMembers } from "../optional-deps.js";
import { contextProgram, type LintContext, type Violation } from "./lint.js";

export function run(context: LintContext): Violation[] {
  return findUnsuppliedOptionalMembers({ program: contextProgram(context), root: context.root, entry: "packages/server/src/index.ts", allowlist: OPTIONAL_MEMBER_ALLOWLIST }).map((found) => ({
    file: found.file,
    line: found.line,
    fromPkg: found.file.split("/")[1] ?? found.file,
    specifier: `${found.declaration}.${found.member}`,
    reason: found.reason,
  }));
}

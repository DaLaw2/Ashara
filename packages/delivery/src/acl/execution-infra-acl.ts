/**
 * Anti-Corruption Layer: Execution Infrastructure.
 *
 * Outside dispatch/, the core loop reads Execution Infrastructure only here: a project's target
 * workspace is validated against the workdir base before anything is run in it.
 */

export { assertValidTargetProjectPath, InvalidTargetProjectPath } from "@ashara/execution-infra";

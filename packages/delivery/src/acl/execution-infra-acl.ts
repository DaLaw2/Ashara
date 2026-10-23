/**
 * Anti-Corruption Layer: Execution Infrastructure.
 *
 * Outside dispatch/, the core loop reads Execution Infrastructure only here: a project's target
 * workspace is validated against the workdir base before anything is run in it, and a dispatch
 * that threw is read for the shutdown's interruption of a command in a cell.
 */

export { assertValidTargetProjectPath, cellExecInterruptedOf, InvalidTargetProjectPath } from "@ashara/execution-infra";

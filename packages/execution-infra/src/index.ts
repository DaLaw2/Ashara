export { PodmanSubstrate, cellRunBoundMs } from "./podman.js";
export type { Cell, CellSpec, ExecResult, SubstrateInfo } from "./podman.js";
export { CELL_LIMIT_VARIABLES, readCellLimits } from "./cell-limits.js";
export type { CellResourceLimits } from "./cell-limits.js";
export { probeCredentialRead, probeOutboundHost, probeResourceCaps, summarizeProbes } from "./cell-probes.js";
export type { CredentialCanaries, ProbeVerdict } from "./cell-probes.js";
export { createCellBackend } from "./cell-backend.js";
export type { CellBackend } from "./cell-backend.js";
export { loadBaseCell } from "./base-cell.js";
export type { BaseCellReference } from "./base-cell.js";
export {
  CellStartFailed,
  CellTeardownFailed,
  CellToolFailed,
  InvalidCellRequest,
  MountPathRejected,
  PathOutsideWorkspace,
  SubstrateUnavailable,
} from "./errors.js";
export { CellExecFailed } from "./errors.js";
/** @testseam the integration cell.podman.test.ts asserts the refusal class; loadBaseCell throws it */
export { BaseCellConfigInvalid } from "./errors.js";
export { WORKSPACE_ROOT } from "./workspace-path.js";
export { execFileGitRunner, runHostGit, withGitRunner } from "./host-git.js";
export type { GitRunner, HostRepo } from "./host-git.js";
export { freshWorktreeRepo, targetRepo } from "./target-repo.js";
export { TreePathRefused, listTreeDir, readTreeFile, treeHasEntry, writeTreeFile } from "./tree-read.js";
export type { TreeFileRead } from "./tree-read.js";
export { CheckoutHolderOverran, canonicalizeAllowingMissing, withTargetCheckout } from "./checkout-lock.js";
export type { CheckoutLease } from "./checkout-lock.js";
export {
  InvalidTargetProjectPath,
  WorktreeCommitFailed,
  WorktreeCommitIncomplete,
  assertValidTargetProjectPath,
  buildFileTree,
  checkoutsRoot,
  cleanupWorkdir,
  clearWorktreeSlot,
  commitAllChanges,
  commitPartialWork,
  createWorkdir,
  createWorkdirForRetry,
  ensureTargetGitInit,
  getChangedFiles,
  mergeInProgress,
  removeThrowawayCheckouts,
  sweepOrphanedWorktrees,
} from "./worktree.js";
export type { PartialCommitOutcome, WorkdirInfo } from "./worktree.js";
export { pruneStaleEnvironmentImages, resolveCurrentEnvironment } from "./current-environment.js";
export type { CurrentEnvironment, EnvironmentImages, EnvironmentStatementSource } from "./current-environment.js";
export type { AttemptCellImage, EnvironmentCheckReport, EnvironmentTestRun } from "./environment-report.js";
export {
  buildAndProbe,
  commitForCheck,
  runEnvironmentCommand,
  runProbeOnCheckout,
  withCheckoutCell,
  worktreeCommitLine,
} from "./checkout-cell.js";
export type { EnvironmentCheckScope } from "./checkout-cell.js";
export { cellInstanceFor, reconcileCellsAtStartup, releaseHeldCells, substrateProbe, teardownCellsAtShutdown } from "./cells.js";
export { elidedOutput, spawnProcess } from "./process-runner.js";
export type { ProcessRunner } from "./process-runner.js";
export {
  buildContextFields,
  buildContextPaths,
  ENVIRONMENT_DEFINITION_PATH,
  ENVIRONMENT_DIR,
  parseEnvironmentFile,
  readEnvironmentFile,
  recipePaths,
  refineBuildContext,
} from "./environment.js";
export { environmentVersion } from "./environment.js";
export { ENVIRONMENT_BUILD_TIMEOUT_MS, buildEnvironmentImage, pruneEnvironmentImages } from "./environment-build.js";
export type { BuiltEnvironment } from "./environment-build.js";
export { EnvironmentBuildFailed, EnvironmentDefinitionInvalid, EnvironmentVersionUnresolved, PodmanCommandFailed } from "./errors.js";
/** @testseam the integration environment-build.test.ts asserts the class; buildEnvironmentImage throws it */
export { EnvironmentBuildUnrecorded } from "./errors.js";

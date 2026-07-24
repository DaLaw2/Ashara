// DEPRECATED: The HTTP server on port 3001 is removed. Brief assembly and
// verify now run inline inside agent-runner. These re-exports remain so
// other packages can still import the pure functions.

export type { PrunerConfig, PrunedChunk, PruningResult } from "./pruner.js";
export { pruneContext, splitAtSyntaxBoundaries, DEFAULT_MIN_RELEVANCE } from "./pruner.js";

export type { RetrieveFn } from "./dispatch-utils.js";
export { buildAutoProfile, buildDefaultProfile, buildProjectContext, createRetrievalFn, detectTechStack, readManifestContext } from "./dispatch-utils.js";

export type { Message, MaskingConfig, MaskingResult } from "./observation-masking.js";
export { ObservationMasker } from "./observation-masking.js";

export type { BriefConfig, ProjectProfile, Brief, QualityCheckResult, QualityGateResult } from "./brief-assembly.js";
export {
  assembleBrief,
  checkQualityGate,
  buildBriefWithRetry,
  formatSystemPrompt,
  formatProjectProfile,
  formatTaskSpec,
  formatCodeContext,
} from "./brief-assembly.js";

export type {
  AgentBrief,
  TaskSpec,
  CheckResult,
  TierResult,
  VerifyRequest,
  VerifyResponse,
} from "./types.js";
export type { ContractSource } from "./contract-slice.js";
export { formatContractSlice } from "./contract-slice.js";
export type { ContractAmender, CompletionDeliverables } from "./contract-completion.js";
export { selectModulePaths } from "./contract-completion.js";
export type { VerifyLogOptions } from "./verify.js";
export { verify } from "./verify.js";
export { runVerifyCore, InvalidVerifyPathError } from "./verify-core.js";

export { prepare, ToolchainError, isSafeToolchainCommand } from "./project-toolchain.js";
export type {
  PackageManager,
  ToolchainStep,
  ToolchainErrorContext,
  ToolchainLogFn,
  ToolchainDeps,
  CodegenOutcome,
  ToolchainResult,
} from "./project-toolchain.js";

export { observeProduct } from "./gates/observe.js";
export type { ObserveDeps } from "./gates/observe.js";
export { DevelopmentService } from "./execution-service.js";
export type { WorkdirInfo } from "./workspace.js";
export { assertValidTargetProjectPath, InvalidTargetProjectPath } from "./workspace.js";
export type { MergeResult } from "./merge.js";
export {
  taskBranchName,
  branchExists,
  captureMainHead,
  tentativeMerge,
  commitMerge,
  abortMerge,
  recoverOrphanedMerge,
  buildMergeAgentBrief,
} from "./merge.js";
export { buildKnowledgeQueryText } from "./knowledge-writer.js";
export type { KnowledgeSink, KnowledgeSource, KnowledgeScope } from "./knowledge-writer.js";
export type {
  SessionStore,
  AgentInvoker,
  AgentSpawnOptions,
  ConventionsExtractor,
  ExecutionEventSink,
  DevelopmentConfig,
  TaskDescriptor,
  ExecutionResult,
  DevelopmentServiceDeps,
} from "./execution-service.js";

export type { VerifyCheck, VerifyConfig } from "./verify-config.js";
export { readVerifyConfig } from "./verify-config.js";

export type { AttributionResult, WorkItemLookup, GitLogRunner } from "./gates/attribution.js";
export { extractImplicatedFiles, attributeFilesToTasks } from "./gates/attribution.js";

export type { ProjectId, WorkItemId, SessionId } from "./ids.js";
export { parseProjectId, parseWorkItemId, createWorkItemId, createSessionId } from "./ids.js";

export type { WorkItemLevel, WorkItemStatus, CapabilityLevel, SessionPhase } from "./enums.js";
export {
  TERMINAL_SESSION_PHASES,
  WORK_ITEM_STATUSES,
  parseCapabilityLevel,
  parseWorkItemLevel,
  parseWorkItemStatus,
} from "./enums.js";

export type { AgentRunnerEnv } from "./env.js";
export {
  loadProviderKeys,
  loadProviderBaseUrls,
  loadBudgetEnv,
  loadServerEnv,
  loadAgentRunnerEnv,
  loadDiagnosticsEnabledEnv,
  loadModelsConfigPathEnvOverride,
} from "./env.js";

export { extractJson } from "./json-utils.js";

export type { DomainEvent } from "./types.js";
export { createDomainEvent } from "./types.js";

export type {
  ProjectKnowledge,
  ProjectKnowledgeNode,
  ContractBody,
  ContractInput,
  ContractDelta,
  Endpoint,
  ContractModule,
  Mount,
  ProjectContract,
} from "./contract.js";
export {
  HttpMethodSchema,
  ProjectKnowledgeSchema,
  ContractBodySchema,
  ContractDeltaSchema,
  nodesByKind,
  nodeByKind,
  nodeLabel,
  nodeLabels,
  normalizePath,
} from "./contract.js";

export type { ProjectFrame, ProjectFrameAttempt } from "./project-frame.js";
export { ProjectFrameSchema, ProjectFrameUnresolvable } from "./project-frame.js";

export type { AgentBrief } from "./agent-brief.js";
export { createAgentBrief, parseAgentBrief } from "./agent-brief.js";

export { loadSkipDirs } from "./gitignore.js";

export type { EndpointProbe, ProductObservation } from "./observation.js";

export type { ErrorLayer, ErrorEnvelope } from "./error-envelope.js";
export {
  errorEnvelopeSchema,
  wrapError,
  flattenChain,
  renderChainForBrief,
} from "./error-envelope.js";

export {
  TERMINAL_STATUSES,
  canTransitionTo,
  InvalidStatusTransition,
  WorkItemNotFound,
  RepositoryError,
  ContractVersionConflict,
} from "./transitions.js";

export type { RunState } from "./run-state.js";
export { parseRunState, serializeRunState } from "./run-state.js";

export type { StoredTaskSpec } from "./task-spec.js";
export { parseStoredTaskSpec } from "./task-spec.js";

export type { StoredBlockedReason } from "./blocked-reason.js";
export { blockedReasonToRecord, parseStoredBlockedReason, withSubstitutedBy, withSalvagedResult } from "./blocked-reason.js";

export type { StoredSuccessCriteria } from "./success-criteria.js";
export { parseStoredSuccessCriteria } from "./success-criteria.js";

export { RUN_SCOPE_PRE_SCOPING, RUN_SCOPE_AD_HOC, parseRunScope } from "./run-scope.js";

export type { ContractRepository } from "./repository-ports.js";

export { ASHARA_CONTROL_DIR, CONVERSATION_RECORDS_DIR, isAsharaControlPath } from "./workspace-layout.js";

export { TargetPackageJsonSchema } from "./target-package-json.js";

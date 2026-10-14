export type { ProjectId, WorkItemId } from "./ids.js";
export { parseProjectId, parseWorkItemId, InvalidId, createWorkItemId, createSessionId } from "./ids.js";

export type { AttemptTerminal, WorkItemLevel, WorkItemStatus, CapabilityLevel } from "./enums.js";
export {
  ATTEMPT_TERMINALS,
  CapabilityLevelSchema,
  TERMINAL_SESSION_PHASES,
  parseCapabilityLevel,
  parseWorkItemLevel,
  parseWorkItemStatus,
} from "./enums.js";
export { WORK_ITEM_STATUSES } from "./enums.js";
export { PROJECT_STATUSES } from "./enums.js";

export { loadModelsConfigPathEnvOverride } from "./env.js";

export { extractJson } from "./json-utils.js";

export type { SerializedError } from "./error-chain.js";
export { describeErrorChain, serializeError } from "./error-chain.js";

export type { Clock } from "./clock.js";
export { systemClock } from "./clock.js";

export type { ContendedWaitKind, ContendedWaitObserver } from "./contended-wait.js";
export { contendedWait, observeContendedWaits } from "./contended-wait.js";

export type { DomainEvent } from "./types.js";
export { createDomainEvent } from "./types.js";

export type {
  ProjectKnowledge,
  ContractBody,
  ContractInput,
  ContractDelta,
  ProjectContract,
} from "./contract.js";
export {
  ProjectKnowledgeSchema,
  ContractBodySchema,
  ContractDeltaSchema,
  nodeByKind,
} from "./contract.js";

export type { AgentBrief } from "./agent-brief.js";
export { createAgentBrief } from "./agent-brief.js";

export type { AssumptionDisclosure, AssumptionKind, AssumptionStanding, ScopeLine, ScopeSide } from "./vision-assumption.js";
export {
  ASSUMPTION_KIND_LABEL,
  ASSUMPTION_STANDING_LABEL,
  AssumptionKindSchema,
  PUBLIC_INTERFACE_FILE,
  StoredAssumptionDisclosureSchema,
  StoredAssumptionKindSchema,
  StoredScopeLineSchema,
  assumptionStanding,
} from "./vision-assumption.js";


export type { ErrorLayer, ErrorEnvelope } from "./error-envelope.js";
export {
  errorEnvelopeSchema,
  wrapError,
  flattenChain,
  renderChainForBrief,
} from "./error-envelope.js";

export {
  canTransitionTo,
  InvalidStatusTransition,
  WorkItemNotFound,
  RepositoryError,
  ContractVersionConflict,
} from "./transitions.js";
export { OUTBOUND_TRANSITIONS } from "./transitions.js";


export type { StoredTaskSpec, VisionSource } from "./task-spec.js";
export { parseStoredTaskSpec, visionSourceLine } from "./task-spec.js";

export type { MergeKind, StoredBlockedReason } from "./blocked-reason.js";
export { BLOCKED_REASON_SOURCES } from "./blocked-reason.js";
export { BlockedReasonCorrupt, blockedExitOf, blockedReasonToRecord, parseStoredBlockedReason, withSalvagedResult } from "./blocked-reason.js";

export type { StoredSuccessCriteria } from "./success-criteria.js";

export type { ProjectBlockCause } from "./work-item-row.js";
export { SPEND_CAP_ERROR_CLASS, WorkItemRowCorrupt, parseWorkItemJsonb, projectBlockCause } from "./work-item-row.js";

export { RUN_SCOPE_AD_HOC, parseRunScope } from "./run-scope.js";

export type { WorkKind } from "./work-kind.js";
export { WORK_KINDS, parseWorkKind } from "./work-kind.js";

export type { ContractRepository } from "./repository-ports.js";

export { CONVERSATION_RECORDS_DIR } from "./workspace-layout.js";


export type { ElidedText } from "./elided-text.js";
export { cutText, headBudget, joinElided, keepEnds, renderElided, shownText, uncutText, wholeText } from "./elided-text.js";

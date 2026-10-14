export type { ProjectId, WorkItemId } from "./ids.js";
export { parseProjectId, parseWorkItemId, InvalidId, createWorkItemId, createSessionId } from "./ids.js";

export type { WorkItemLevel, WorkItemStatus, CapabilityLevel } from "./enums.js";
export {
  CapabilityLevelSchema,
  TERMINAL_SESSION_PHASES,
  parseCapabilityLevel,
  parseWorkItemLevel,
  parseWorkItemStatus,
} from "./enums.js";
/** @testseam db lifecycle-lists.test.ts compares it with the CHECK constraint; the lifecycle model of story s-independent-verify-m1 L2 is its consumer */
export { WORK_ITEM_STATUSES } from "./enums.js";
/** @testseam db lifecycle-lists.test.ts compares it with the CHECK constraint; the lifecycle model of story s-independent-verify-m1 L2 is its consumer */
export { PROJECT_STATUSES } from "./enums.js";

export { loadModelsConfigPathEnvOverride } from "./env.js";

export { extractJson } from "./json-utils.js";

export type { SerializedError } from "./error-chain.js";
export { describeErrorChain, serializeError } from "./error-chain.js";

export type { Clock } from "./clock.js";
export { systemClock } from "./clock.js";

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
/** @testseam transitions.test.ts walks it; the lifecycle model of story s-independent-verify-m1 L2 is its consumer */
export { OUTBOUND_TRANSITIONS } from "./transitions.js";


export type { StoredTaskSpec } from "./task-spec.js";

export type { BlockedExit, StoredBlockedReason } from "./blocked-reason.js";
/** @testseam blocked-reason.test.ts checks it names every source; the lifecycle model of story s-independent-verify-m1 L2 is its consumer */
export { BLOCKED_REASON_SOURCES } from "./blocked-reason.js";
export { blockedExitOf, blockedReasonToRecord, withSalvagedResult } from "./blocked-reason.js";

export type { StoredSuccessCriteria } from "./success-criteria.js";

export type { ProjectBlockCause } from "./work-item-row.js";
export { WorkItemRowCorrupt, parseWorkItemJsonb, projectBlockCause } from "./work-item-row.js";

export { RUN_SCOPE_AD_HOC, parseRunScope } from "./run-scope.js";

export type { WorkKind } from "./work-kind.js";
export { WORK_KINDS, parseWorkKind } from "./work-kind.js";

export type { ContractRepository } from "./repository-ports.js";

export { CONVERSATION_RECORDS_DIR } from "./workspace-layout.js";


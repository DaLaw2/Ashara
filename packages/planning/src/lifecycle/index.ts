export type { EventPublisher, EventSink, ModulePathFilter } from "./ports.js";

export type { ContractRegistryLookup, FailureRecoveryDeps } from "./failure-recovery.js";
export { recoverFailedItem, applyAbandon } from "./failure-recovery.js";

export type { TaskSplitDeps } from "./task-split.js";
export { shouldSplit, splitFailedTask } from "./task-split.js";

export type { TerminationItemSnapshot, TerminationSnapshot } from "./termination.js";
export { evaluate } from "./termination.js";

export type { SnapshotAssemblyDeps } from "./termination-snapshot.js";
export { assembleRunSummaryItems, isRecoverableFailed } from "./termination-snapshot.js";

export type { RunSummaryItem, RunSummaryInput } from "./run-summary.js";
export { buildRunSummary, emitRunSummary } from "./run-summary.js";

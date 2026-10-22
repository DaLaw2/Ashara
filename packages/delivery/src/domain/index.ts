export type { StoredFailureVerdict, WorkItem } from "./work-item.js";
export {
  createPendingWorkItem,
  startWorkItem,
  failWorkItem,
  blockWorkItem,
  holdForCorrection,
  unblockWorkItem,
  replanWorkItem,
  abandonWorkItem,
  requeueWorkItem,
  supersedeWorkItem,
  giveUpWorkItem,
  takeEvents,
} from "./work-item.js";

export { exitDisputedCheck, exitStaleChecks, exitSuiteReview } from "./stale-checks.js";

export { requestEnvironmentChange } from "./environment-change.js";

export {
  awaitWork,
  clientWaitPastBound,
  deliveringTasks,
  giveUpUnaskable,
  holdForClient,
  resolveInterfaceEntries,
  resumeOnAnswer,
} from "./prerequisite-wait.js";
export type { InterfaceTable } from "./prerequisite-wait.js";

export { salvagedReason } from "./salvaged-result.js";

export { giveUpAcceptanceDefect, openAcceptanceDefect } from "./acceptance.js";
export type { InterfaceDefect, PlaceholderDefect } from "./acceptance.js";

export type { ActiveProjects, WorkItemRepository } from "./repository.js";

export { PlanningService } from "./service.js";
export { TaskHeldForCorrection, startUnlessHeld } from "./gate.js";
export type { GatedWork } from "./gate.js";

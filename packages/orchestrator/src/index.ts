export type {
  CoreLoopConfig,
  CoreLoopDeps,
  TaskLanes,
} from "./types.js";
export { DEFAULT_CONFIG } from "./types.js";
export type { AcceptanceStore } from "./acceptance.js";
/** @testseam the integration acceptance.test.ts drives the sweep's records against Postgres through it; CoreLoop.runCycle is its production caller */
export { runAcceptanceSweeps } from "./acceptance.js";

export { CoreLoop, concurrentTaskLanes } from "./core-loop.js";
/** @testseam the server replan-store.test.ts sweeps a Blocked owner_unresolved row against Postgres through it; CoreLoop.runCycle is its production caller */
export { releaseClearedBlocks } from "./parked-exits.js";
/** @testseam the integration task-helpers.test.ts resolves workspaces against Postgres through it; the execution path is its production caller */
export { resolveTargetProjectPath } from "./task-helpers.js";

export { ContinuousRunner } from "./runner.js";
export type { CycleRunner } from "./runner.js";


export { reconcileWorkItemsOnStartup } from "./startup-reconciler.js";

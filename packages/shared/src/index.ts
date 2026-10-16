export type { ProjectId, WorkItemId } from "./ids.js";
export { parseProjectId, parseWorkItemId, InvalidId, createWorkItemId } from "./ids.js";

export type { SerializedError } from "./error-chain.js";
export { describeErrorChain, serializeError } from "./error-chain.js";

export type { ErrorLayer } from "./error-envelope.js";
export { errorLayerSchema, flattenChain, wrapError } from "./error-envelope.js";

export type { Clock } from "./clock.js";
export { systemClock } from "./clock.js";

export type { ContendedWaitKind, ContendedWaitObserver } from "./contended-wait.js";
export { contendedWait, observeContendedWaits } from "./contended-wait.js";

export type { StepContainment, StepFaultLedger, StepFaultStanding, StepFaulted } from "./contained-step.js";
export { UnreadSubject, containEach, faultBackoffSeconds, readEach, uncontainedSteps } from "./contained-step.js";
/** @testseam the simulator may not import it (ADR-081), so a cross-package test holds the simulator's report retry wait equal to it */
export { FIRST_FAULT_BACKOFF_SECONDS } from "./contained-step.js";
/** @testseam unit tests of the cycle's steps contain their subjects with it; the composition root supplies db's ledger */
export { memoryStepContainment } from "./contained-step.js";

export type { DomainEvent } from "./types.js";
export { createDomainEvent } from "./types.js";

export { JsonParseFailed, parseJson } from "./json.js";

export type { ElidedText } from "./elided-text.js";
export { cutText, headBudget, joinElided, keepEnds, renderElided, shownText, uncutText, wholeText } from "./elided-text.js";

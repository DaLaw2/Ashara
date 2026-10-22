/**
 * The shared kernel's test support, reached as `@ashara/shared/testing`: only a test file, the test
 * harness or another package's test support may import it (test-only-subpaths in boundary-rules.toml).
 */

export { memoryStepContainment } from "./contained-step.js";
export { recordingLogger } from "./log.js";
export { notExercised } from "./not-exercised.js";
/** @testseam a test tells an unexpected call from its own failure by it; notExercised throws it */
export { NotExercised } from "./not-exercised.js";

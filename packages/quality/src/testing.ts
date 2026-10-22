/**
 * Quality's test support, reached as `@ashara/quality/testing`: only a test file may import it
 * (test-only-subpaths in boundary-rules.toml), so production constructs its reviewer itself.
 */

import type { Logger } from "@ashara/shared";
import { recordingLogger } from "@ashara/shared/testing";
import { SuiteReviewer } from "./suite-review.js";
import type { SuiteReviewerDeps } from "./suite-review.js";

/**
 * A reviewer for a test: its records captured by a recording logger unless `deps` names a logger. A
 * dependency the reviewer gains is added here once, never at each test's construction.
 * @testseam every test builds its reviewer through it; the composition root constructs production's
 */
export function suiteReviewerFor(deps: Omit<SuiteReviewerDeps, "logger"> & { readonly logger?: Logger }): SuiteReviewer {
  return new SuiteReviewer({ ...deps, logger: deps.logger ?? recordingLogger() });
}

import type { KnownLLMSite } from "@ashara/model-access";

/**
 * What a model request is for, as the work ledger's verification reserve reads it (ADR-084
 * addendum 1 decision 6): `verification`, checking and accepting work already built (the check
 * runs that decide a task, acceptance sweeps, post-merge checks, the delivered report), which may
 * draw the reserve; `upstream`, every other request (planning, check authoring, suite review,
 * implementation, the Liaison's reading of the client), which may not.
 */
export type WorkPurpose = "upstream" | "verification";

/**
 * Every call site's purpose. A Record over KnownLLMSite, so a site registered without a purpose is
 * a compile error, and work-ledger.test.ts reads it against KNOWN_LLM_SITES. Every site that sends
 * a model request today does upstream work: the verification steps (check runs, acceptance sweeps,
 * post-merge checks, the delivered report) run Z0's commands and send none. `escalation` is the
 * ladder's tier, never a request's own site, and earns no reserve it was not given.
 */
export const CALL_SITE_PURPOSE: Readonly<Record<KnownLLMSite, WorkPurpose>> = {
  // A dispatched attempt: implementation, check authoring and environment work alike.
  "agent-runner": "upstream",
  decomposition: "upstream",
  "liaison-intake": "upstream",
  roster: "upstream",
  "suite-review": "upstream",
  escalation: "upstream",
};

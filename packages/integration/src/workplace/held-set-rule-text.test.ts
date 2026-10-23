import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attemptProfileOf } from "@ashara/delivery";
import { CHECK_MISSING_EXIT, CHECK_VERDICT, HELD_SET_RULE, heldSetRuleText, offeredToolSchemas } from "@ashara/workplace";

// The held-set rule reaches an author in several texts: the check author's charter, define_check's
// description and its answer, and the check task's success criteria. Each renders it from the one
// value Quality's red run applies, so none can state another rule.

const PACKAGES = join(import.meta.dirname, "..", "..", "..");

/** The sources that state the held-set rule to an author, and the one that defines its text. */
const AUTHOR_TEXTS = [
  "organization/src/charter.ts",
  "workplace/src/tools.ts",
  "delivery/src/decomposition.ts",
  "delivery/src/core-loop.ts",
  "delivery/src/domain/stale-checks.ts",
] as const;
const RULE_SOURCE = "workplace/src/check-definition.ts";

/** Wordings of the rule a text could state by hand instead of rendering the value. */
const HAND_WRITTEN = [/at least one check/i, /must fail on the foundation/i, /at least one fails/i];

function source(path: string): string {
  return readFileSync(join(PACKAGES, path), "utf8");
}

/** `text` without the body of heldSetRuleText, the one place the rule's words are written. */
function outsideRuleText(text: string): string {
  const start = text.indexOf("export function heldSetRuleText(");
  const end = text.indexOf("\n}\n", start);
  expect(start, "heldSetRuleText is defined in its source").toBeGreaterThan(-1);
  return text.slice(0, start) + text.slice(end);
}

describe("the held-set rule as authors are told it", () => {
  it("is stated only through the rule value: no author-facing source words it by hand", () => {
    for (const path of AUTHOR_TEXTS) {
      for (const wording of HAND_WRITTEN) expect(source(path), `${path} ${String(wording)}`).not.toMatch(wording);
    }
    for (const wording of HAND_WRITTEN) expect(outsideRuleText(source(RULE_SOURCE)), `${RULE_SOURCE} ${String(wording)}`).not.toMatch(wording);
  });

  it("renders the rule value in the check author's charter, define_check's description and the check task's criteria", () => {
    const rule = heldSetRuleText(HELD_SET_RULE);
    expect(attemptProfileOf("check").charter.duties).toContain(rule);
    const defineCheck = Object.entries(offeredToolSchemas()).filter(([name]) => name.endsWith("/define_check"));
    expect(defineCheck.length).toBeGreaterThan(0);
    for (const [name, schema] of defineCheck) expect(schema.description, name).toContain(rule);
    for (const path of ["organization/src/charter.ts", "workplace/src/tools.ts", "delivery/src/decomposition.ts"]) {
      expect(source(path), path).toContain("heldSetRuleText(HELD_SET_RULE)");
    }
    // The stale checks' reopen reason and the dispute's brief each render it.
    expect(source("delivery/src/domain/stale-checks.ts").split("heldSetRuleText(HELD_SET_RULE)")).toHaveLength(3);
  });

  it("is the one source of the decisive exit: the per-check verdict states the rule's exit", () => {
    expect(CHECK_MISSING_EXIT).toBe(HELD_SET_RULE.decisiveExit);
    expect(source(RULE_SOURCE)).toContain("export const CHECK_MISSING_EXIT = HELD_SET_RULE.decisiveExit;");
    expect(CHECK_VERDICT).toContain(`exit ${HELD_SET_RULE.decisiveExit}`);
  });

  it("gives a task no fewer identical rejections than the production failure router gives any failed attempt", () => {
    const bound = /new FailureRouter\((\d+)\)/.exec(source("server/src/compose.ts"))?.[1];
    expect(bound, "compose.ts constructs the failure router with an explicit bound").toBeDefined();
    expect(HELD_SET_RULE.giveUpAfter).toBeGreaterThanOrEqual(Number(bound));
  });

  it("states the bound the red run gives up at, from the same value", () => {
    expect(heldSetRuleText({ ...HELD_SET_RULE, giveUpAfter: 7 })).toContain("after 7 identical rejections");
    expect(heldSetRuleText({ ...HELD_SET_RULE, decisiveExit: 42 })).toContain("by exiting 42");
  });
});

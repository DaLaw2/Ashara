import { describe, expect, test } from "vitest";
import type { RetrievalResult } from "@ashara/memory";
import {
  assembleBrief,
  checkQualityGate,
  formatAcceptanceCriteria,
  EMPTY_CODE_CONTEXT,
  EMPTY_WORKDIR_CONTEXT_MAP,
} from "./brief-assembly.js";
import type { ProjectProfile } from "./brief-assembly.js";
import type { TaskSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Run 39: the Go target indexed zero files, so retrieval returned nothing, so
// the relevance check reported "No retrieval results to check" and PASSED —
// an empty ratio reading as full agreement. Absence must be reported as
// absence, and only excused where zero is the expected observation.
// ---------------------------------------------------------------------------

const PROFILE: ProjectProfile = {
  name: "project",
  techStack: ["Go"],
  buildCommand: "",
  testCommand: "",
  lintCommand: "",
  conventions: [],
  moduleBoundaries: "",
};

const SPEC: TaskSpec = {
  goal: "add a note command",
  endState: "notes can be added",
  scope: "cmd/",
  deliverables: ["cmd/add.go"],
  checks: ["go build ./..."],
};

function chunk(score: number): RetrievalResult {
  return {
    filePath: "cmd/add.go",
    startLine: 1,
    endLine: 5,
    content: "package main\n\nfunc add() {}\n",
    source: "keyword",
    score,
  };
}

describe("empty retrieval is absence, not agreement", () => {
  test("fails the relevance check when the project already has files", () => {
    const brief = assembleBrief(SPEC, [], PROFILE, {}, "# Project Context\n\n- cmd/add.go", "");
    const gate = checkQualityGate(brief, []);

    expect(gate.failedChecks).toContain("relevance");
    expect(gate.checks.relevance.passed).toBe(false);
    expect(gate.checks.relevance.detail).toContain("ZERO chunks");
  });

  test("still passes for a greenfield project, where zero is the expected observation", () => {
    const brief = assembleBrief(SPEC, [], PROFILE, {}, EMPTY_WORKDIR_CONTEXT_MAP, "", true);
    const gate = checkQualityGate(brief, []);

    expect(gate.checks.relevance.passed).toBe(true);
    expect(gate.checks.relevance.detail).toContain("greenfield");
    // The greenfield economy exception must survive the new code-context
    // sentinel — EMPTY_CODE_CONTEXT is prose about absence, not context.
    expect(gate.checks.economy.passed).toBe(true);
  });

  test("greenfield with prior knowledge still passes economy gate", () => {
    const knowledgeContext = "## Recent Findings\n- prior attempt learned something";
    const brief = assembleBrief(SPEC, [], PROFILE, {}, EMPTY_WORKDIR_CONTEXT_MAP, knowledgeContext, true);
    const gate = checkQualityGate(brief, []);

    expect(gate.checks.economy.passed).toBe(true);
    expect(gate.checks.economy.detail).toContain("greenfield");
  });

  test("states the emptiness in the brief the agent reads", () => {
    const brief = assembleBrief(SPEC, [], PROFILE, {}, "", "");
    expect(brief.codeContext).toBe(EMPTY_CODE_CONTEXT);
    expect(brief.codeContext).toContain("NOT evidence that no relevant code");
  });

  test("a non-empty result set is still judged on its scores", () => {
    const results = [chunk(0.9), chunk(0.8)];
    const brief = assembleBrief(SPEC, results, PROFILE, {}, "# Project Context", "");
    const gate = checkQualityGate(brief, results);

    expect(gate.checks.relevance.passed).toBe(true);
    expect(gate.checks.relevance.detail).toContain("2/2");
  });
});

// ---------------------------------------------------------------------------
// formatAcceptanceCriteria: successCriteria reach the brief through their own
// section, distinct from the check runner's Verification Checks.
// ---------------------------------------------------------------------------

describe("formatAcceptanceCriteria", () => {
  test("renders criteria as a bulleted list under its own heading", () => {
    const result = formatAcceptanceCriteria([
      "API returns 200 with valid JSON",
      "Error responses follow standard format",
      "Invalid input returns 400",
    ]);

    expect(result).toBe(
      "## Acceptance Criteria\n" +
      "- API returns 200 with valid JSON\n" +
      "- Error responses follow standard format\n" +
      "- Invalid input returns 400",
    );
  });

  test("returns empty string when criteria list is empty", () => {
    expect(formatAcceptanceCriteria([])).toBe("");
  });

  test("renders a single criterion without fabricating extras", () => {
    const result = formatAcceptanceCriteria(["tests pass"]);
    expect(result).toBe("## Acceptance Criteria\n- tests pass");
  });
});

/**
 * Brief section renderers: the task spec and acceptance criteria the agent reads,
 * and the explicit empty-working-directory context map.
 */

import type { TaskSpec } from "./types.js";

/**
 * The context map for a working directory with no files in it (ADR-046). An
 * empty string would render as no context section at all — indistinguishable to
 * the agent from a normal project — so emptiness is stated instead of implied.
 * The Sprint 0 task sees this on a new project: it runs before any other task.
 */
export const EMPTY_WORKDIR_CONTEXT_MAP = [
  "# Project Context",
  "",
  "The working directory is empty. No files exist yet; read_file, list_directory and",
  "search_codebase will return nothing. Nothing about this project can be detected —",
  "what is known is stated under Project above.",
].join("\n");

export function formatTaskSpec(spec: TaskSpec): string {
    return [
        "# Task",
        "",
        "## Goal",
        spec.goal,
        "",
        "## End State",
        spec.endState,
        "",
        "## Scope",
        spec.scope,
        "",
        "## Deliverables",
        ...spec.deliverables.map((d, i) => `${i + 1}. ${d}`),
    ].join("\n");
}

/**
 * Renders success criteria as a brief section the agent reads as its acceptance
 * target: prose the agent aims for, not commands anything executes. Returns "" when the list is
 * empty — an absent section, not a fabricated one (Discipline A).
 */
export function formatAcceptanceCriteria(criteria: readonly string[]): string {
    if (criteria.length === 0) return "";
    return [
        "## Acceptance Criteria",
        ...criteria.map((c) => `- ${c}`),
    ].join("\n");
}

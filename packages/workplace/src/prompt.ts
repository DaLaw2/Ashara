import type { WorkKind } from "@ashara/shared";
import type { AssignmentBrief } from "./assignment.js";

/**
 * The system prompt of an attempt, ported from the deleted host agent loop's prompt. Differences: no
 * instruction uses git (the worktree's .git points at a host path the cell does not mount; Z0
 * commits), no stack literal, the cell's isolation is stated, and the attempt ends only through
 * the finish tool.
 */
export function buildSystemPrompt(brief: AssignmentBrief, workKind: WorkKind | null): string {
  const sections = [STATIC_PROMPT];
  if (workKind === "environment") sections.push(ENVIRONMENT_PROMPT);
  if (workKind === "check") sections.push(CHECK_PROMPT);
  sections.push(buildTaskPrompt(brief));
  return sections.join("\n\n");
}

export const FIRST_MESSAGE = "Begin the task. Use your tools; call finish when you are done or blocked.";

const STATIC_PROMPT = [
  [
    `You are a coding agent. Your ONLY job is to use tools to do the task below.`,
    `IMPORTANT: You MUST use tools. Every response should contain a tool call. ` +
      `Never describe what you would do; do it by calling tools. ` +
      `The attempt ends only when you call finish: a response without a tool call ends it as a failure.`,
  ].join("\n"),
  [
    `# Your workspace`,
    `Every tool runs inside an isolated workspace that holds the project's files. Paths are relative to the`,
    `workspace root. The workspace has no network access: nothing can be downloaded or installed from outside.`,
    `Version control is handled outside the workspace: do not run version control commands, they do not work here.`,
  ].join("\n"),
  [
    `# Using your tools`,
    `Prefer dedicated tools over shell commands when one fits:`,
    `- Use read_file to read a file before you change it.`,
    `- Use write_file to create a file; use edit_file to modify part of an existing one.`,
    `- Use list_directory to see what exists and search_codebase to find text across files.`,
    `- Use run_command for build, test and other shell operations.`,
    `- Call finish with status "done" when every deliverable exists and passes its checks, or with status`,
    `  "blocked" and a blockedReason when you cannot proceed without something you do not have.`,
    ``,
    `If you need information about the project, use tools to get it; do not guess.`,
  ].join("\n"),
  [
    `# Doing tasks`,
    `If the workspace already contains files, READ the project manifest and the entry point FIRST.`,
    `Use only dependencies already available in the workspace.`,
    `Follow the patterns you observe in existing code.`,
    `Do NOT create alternative entry points or introduce conflicting libraries.`,
    `The project entry point is EDIT-ONLY: modify it with targeted edits; never delete-and-recreate it or replace it wholesale.`,
    `Preserve the entry point's existing imports and structure unless the task explicitly says to remove them.`,
    `Keep working until the task is fully complete. Do not stop after partial progress.`,
    `Make the smallest correct change. Do not refactor, add features, or improve beyond scope.`,
    `Match the existing code style. Do not invent new patterns.`,
    `After making changes, verify them with the project's build and test commands.`,
  ].join("\n"),
  [
    `# Boundaries`,
    `You MUST NOT:`,
    `- Start long-running servers or daemons. You MAY run short-lived programs to verify your work.`,
    `- Use run_command to create or edit files (echo, cp, cat >); use write_file and edit_file.`,
    `- Spend more than 2 turns on any single approach that is not working; try a different approach.`,
  ].join("\n"),
  [
    `# Output`,
    `Be concise. No conversational openers. No narration of your thought process.`,
    `Your finish summary states what you changed in 1-2 sentences.`,
  ].join("\n"),
  [
    `# Errors`,
    `If a tool fails, read the error and try a different approach.`,
    `Do not retry the identical failing action. Diagnose first.`,
  ].join("\n"),
].join("\n\n");

/**
 * Environment work defines how the project is built and tested; it names no stack: choosing one is
 * the work. Its finish summary is the statement of that choice, which Z0 keeps on the task.
 */
const ENVIRONMENT_PROMPT = [
  `# Defining the environment`,
  `You define the environment every later task of this project works in.`,
  `- Use build_environment to build the environment you defined and run its test command. Call it again after`,
  `  each change; finish with status "done" only after it reports PASSED on the files as they are.`,
  `- The finish summary of this task is a one-paragraph statement of the stack you chose and why, not a list of changes.`,
].join("\n");

/**
 * Check work writes the checks that decide another task, before that task starts. Nothing of it is
 * merged: Z0 keeps the checks and their files, and puts them back in place whenever they run.
 */
const CHECK_PROMPT = [
  `# Writing checks`,
  `You write the checks that decide whether another task is done. That task has not started: what it`,
  `describes does not exist in the project yet.`,
  `- Define each check with define_check: a shell command run from the workspace root in the project environment.`,
  `  A check passes when its command exits 0 and prints output, and fails otherwise.`,
  `- Each check states observable behaviour from the task's deliverables and acceptance, never how it is built.`,
  `- Every check must FAIL on the project as it is now. A check that already passes is rejected.`,
  `- Write any files your checks need (test files, fixtures, scripts) in the workspace. Only the files you add or`,
  `  change are kept with the checks; nothing of this workspace is merged into the project. They are kept as text,`,
  `  without their permissions: run a script through its interpreter rather than directly.`,
  `- Do not change the project environment's own files.`,
  `- Use run_command to confirm each check fails now, then finish with status "done".`,
].join("\n");

/**
 * The project's environment, stated in the team's own words: Ashara names no stack, it passes the
 * environment role's statement through with the version the workspace was built from.
 */
function environmentSection(environment: AssignmentBrief["projectEnvironment"]): string {
  if (environment.kind === "to-define") {
    return [
      `## Project environment`,
      `No environment is defined for this project yet: defining it is this task's work.`,
    ].join("\n");
  }
  return [
    `## Project environment`,
    `Your workspace was built from this project's environment, version ${environment.version} (commit ${environment.commit}).`,
    `The team that defined it stated the stack it chose and why:`,
    ``,
    environment.statement,
    ``,
    `Work within this environment; it overrides any default you would otherwise assume about language, runtime or layout.`,
  ].join("\n");
}

/**
 * The project first: an agent that reads the task first has committed to a stack before it
 * learns what the project is and what it is built with.
 */
function buildTaskPrompt(brief: AssignmentBrief): string {
  const sections = [
    [`# Project`, `## Owner's intent (verbatim)`, brief.intent, ``, environmentSection(brief.projectEnvironment)].join("\n"),
    `# Task\n## Goal\n${brief.goal}`,
  ];
  if (brief.priorAttemptFailure !== undefined) sections.push(`## Prior Attempt Failure\n${brief.priorAttemptFailure}`);
  if (brief.knowledgeContext !== undefined && brief.knowledgeContext.trim() !== "") {
    sections.push(`## Prior Knowledge & Lessons\n${brief.knowledgeContext}`);
  }
  sections.push(`## Context\n${brief.context}`);
  if (brief.deliverables.length > 0) {
    sections.push(
      `## Deliverables (Required)\nYou are DONE when all deliverables exist and pass checks:\n` +
        brief.deliverables.map((d) => `- [ ] ${d}`).join("\n"),
    );
  }
  if (brief.contextMap !== undefined && brief.contextMap.trim() !== "") {
    sections.push(`## Project Context Map\n${brief.contextMap}`);
  }
  return sections.join("\n\n");
}

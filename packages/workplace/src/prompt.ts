import type { AssignmentBrief, AssignmentCharter, ToolProfile } from "./assignment.js";

/**
 * The system prompt of an attempt, ported from the deleted host agent loop's prompt. Differences: no
 * instruction uses git (the cell's .git is a throwaway repository of its own; Z0 commits), no stack
 * literal, the cell's isolation and its non-root user are stated, and the attempt ends only through
 * the finish tool. Who the agent is and its role's duties are the charter's, which Organization
 * writes and the caller hands over with the assignment.
 */
export function buildSystemPrompt(brief: AssignmentBrief, charter: AssignmentCharter, toolProfile: ToolProfile): string {
  const sections = [staticPrompt(charter.identity)];
  if (charter.duties !== null) sections.push(charter.duties);
  const protectedPaths = protectedPathsSection(brief, toolProfile);
  if (protectedPaths !== null) sections.push(protectedPaths);
  sections.push(buildTaskPrompt(brief));
  return sections.join("\n\n");
}

export const FIRST_MESSAGE = "Begin the task. Use your tools; call finish when you are done or blocked.";

const staticPrompt = (identity: string): string => [
  [
    `${identity} Your ONLY job is to use tools to do the task below.`,
    `IMPORTANT: You MUST use tools. Every response should contain a tool call. ` +
      `Never describe what you would do; do it by calling tools. ` +
      `The attempt ends only when you call finish: a response without a tool call ends it as a failure.`,
  ].join("\n"),
  [
    `# Your workspace`,
    `Every tool runs inside an isolated workspace that holds the project's files. Paths are relative to the`,
    `workspace root. The workspace has no network access: nothing can be downloaded or installed from outside.`,
    `Commands run as a non-root user, never as root. HOME is a writable, empty directory of the workspace's own;`,
    `a path the image made for root is not writable here.`,
    `Version control is handled outside the workspace. The workspace holds a throwaway repository of its own, one`,
    `commit of the files as they were when it started, so tools that read the repository work; nothing done to it is`,
    `kept. Your work is the files you leave: do not run version control commands to record it.`,
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
 * The paths Z0 refuses the work for changing, named before work starts (ADR-074 addendum 2 d66 c,
 * d72 B1), for every task that does not write the recipe itself; null when the brief carries none
 * (the BaseCell) or the attempt builds the environment, which may change the recipe and nothing else.
 */
function protectedPathsSection(brief: AssignmentBrief, toolProfile: ToolProfile): string | null {
  const paths = brief.protectedPaths;
  if (paths === undefined || toolProfile === "build-environment") return null;
  const recipe = paths.recipe.join(", ");
  const checkFiles = paths.checkFiles.length === 0 ? "none is stored yet" : paths.checkFiles.join(", ");
  const inputs = paths.inputs.length === 0 ? "none is named" : paths.inputs.join(", ");
  const lines = [
    `# Protected paths`,
    `Z0 checks your finished work against these paths, whatever else it holds:`,
    `- The environment recipe belongs to the platform role, who builds the project's image from it: ${recipe}.`,
    `- The stored check files belong to the check author who wrote them: ${checkFiles}.`,
    `Every other file is the product's, wherever it lives: its layout, its manifests, its source and its tests.`,
  ];
  if (toolProfile === "define-checks") {
    lines.push(
      `None of your check files may be a recipe file or an input the image build reads (${inputs}). Nothing of your`,
      `workspace is merged, so do not change the project's files for your checks either.`,
    );
    return lines.join("\n");
  }
  lines.push(
    `- Work that changes a stored check file fails, and nothing of it is merged.`,
    `- If your task needs a change to the recipe, make it in your workspace and say in your finish summary what you`,
    `  need and why. Nothing of your work is merged then: Z0 opens an environment task for the platform role carrying`,
    `  your summary and your changes to the recipe, and your task starts again from the project as that task leaves it.`,
    `The inputs the image build reads (${inputs}) are product files: you may change them. A change to one builds the`,
    `image again from your merged work, and the merge is accepted only when the product's build and test and every`,
    `check that verification runs pass on it.`,
  );
  return lines.join("\n");
}

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
    `Your workspace was built from this project's environment, version ${environment.version}.`,
    `The team that defined it stated the stack it chose and why:`,
    ``,
    environment.statement,
    ``,
    `Work within this environment; it overrides any default you would otherwise assume about language, runtime or layout.`,
  ].join("\n");
}

/** The assumptions work proceeds on, by id, each with where it stands with the client, so the agent never contradicts one. */
function assumptionsSection(brief: AssignmentBrief): string {
  const header = [
    `## Assumptions work proceeds on (vision version ${brief.visionVersion})`,
    `Work proceeds on these until the client says otherwise. Each says where it stands with the client: only a Stated`,
    `one is the client's own word; an Inferred one is the team's decision, which the client was asked about or told of`,
    `only as marked. Client-visible behaviour is what the product does for the client; internal design is how the team`,
    `builds it, guidance for the work and never a requirement of the client. Do not contradict any of them. If the`,
    `task cannot be done without contradicting one, finish as blocked and name the assumption by its id.`,
  ];
  if (brief.assumptions.length === 0) return [...header, `None are recorded.`].join("\n");
  return [
    ...header,
    ...brief.assumptions.map((a) => `- ${a.key} (${a.note}): ${a.statement}`),
  ].join("\n");
}

/**
 * The project first: an agent that reads the task first has committed to a stack before it
 * learns what the project is and what it is built with.
 */
function buildTaskPrompt(brief: AssignmentBrief): string {
  const sections = [
    [
      `# Project`,
      `## Owner's intent (verbatim)`,
      brief.intent,
      ``,
      assumptionsSection(brief),
      ``,
      environmentSection(brief.projectEnvironment),
    ].join("\n"),
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

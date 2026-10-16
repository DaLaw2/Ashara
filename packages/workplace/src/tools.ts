import { z } from "zod";
import { CellToolFailed, InvalidCellRequest, PathOutsideWorkspace, elidedOutput } from "@ashara/execution-infra";
import type { CellBackend, ExecResult } from "@ashara/execution-infra";
import type { TurnToolSchema } from "@ashara/finance";
import { joinElided, uncutText, wholeText } from "@ashara/shared";
import type { ElidedText } from "@ashara/shared";
import type { ToolProfile } from "./assignment.js";
import { CHECK_MISSING_EXIT, CHECK_RUNNER, CHECK_VERDICT } from "./check-definition.js";
import type { CheckDefinitionPort, CheckDefinitionResult, FoundationProbe } from "./check-definition.js";
import type { TaskCheckRunPort } from "./check-run.js";
import type { EnvironmentCheckPort } from "./environment-check.js";
import { truncateElided } from "./records.js";

const MAX_LIST_DEPTH = 5;
const DEFAULT_LIST_DEPTH = 2;
const MAX_CHECK_NAME = 100;

const nonEmpty = z.string().min(1);
const nonBlank = z.string().refine((text) => text.trim() !== "", "must not be blank");

const readFileArgs = z.object({ path: nonEmpty }).strict();
const writeFileArgs = z.object({ path: nonEmpty, content: z.string() }).strict();
const editFileArgs = z.object({ path: nonEmpty, old_text: nonEmpty, new_text: z.string() }).strict();
const listDirectoryArgs = z
  .object({ path: nonEmpty.optional(), depth: z.number().int().min(1).max(MAX_LIST_DEPTH).optional() })
  .strict();
const searchArgs = z.object({ pattern: nonEmpty, path: nonEmpty.optional() }).strict();
const runCommandArgs = z.object({ command: nonEmpty, timeout_seconds: z.number().int().positive().optional() }).strict();
const buildEnvironmentArgs = z.object({}).strict();
const runChecksArgs = z.object({}).strict();
const probeFoundationArgs = z.object({ command: nonBlank }).strict();
const defineCheckArgs = z
  .object({
    name: z.string().max(MAX_CHECK_NAME).refine((text) => text.trim() !== "", "must not be blank"),
    command: nonBlank,
    decides: z.tuple([z.string().trim().min(1)], z.string().trim().min(1)),
  })
  .strict();
const MAX_DISPUTE_REASON_CHARS = 4000;
const disputeCheckArgs = z
  .object({
    name: z.string().max(MAX_CHECK_NAME).refine((text) => text.trim() !== "", "must not be blank"),
    task: nonBlank.optional(),
    reason: nonBlank.pipe(z.string().max(MAX_DISPUTE_REASON_CHARS)),
  })
  .strict();
const MAX_STATEMENT_CHARS = 1500;
const blockedFinish = z.object({ status: z.literal("blocked"), summary: nonEmpty, blockedReason: nonEmpty }).strict();
const finishArgs = z.discriminatedUnion("status", [z.object({ status: z.literal("done"), summary: nonEmpty }).strict(), blockedFinish]);
/** Environment work's done carries the stack statement apart from the summary: only the statement reaches the client. */
const environmentFinishArgs = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), summary: nonEmpty, statement: nonBlank.pipe(z.string().max(MAX_STATEMENT_CHARS)) }).strict(),
  blockedFinish,
]);

type FinishArgs = z.infer<typeof finishArgs> | z.infer<typeof environmentFinishArgs>;

const pathProperty = { type: "string", description: "Path relative to the workspace root." } as const;

type ToolSchemas = Readonly<Record<string, TurnToolSchema>>;

/** What the model sees: description and input schema only; the loop executes every call. */
const TOOL_SCHEMAS: ToolSchemas = {
  read_file: {
    description:
      "Read the contents of a file. You MUST read a file before editing it: you need its exact current text.",
    inputSchema: { type: "object", properties: { path: pathProperty }, required: ["path"], additionalProperties: false },
  },
  write_file: {
    description:
      "Create a file or completely overwrite one with the given content. Parent directories are created. " +
      "For a change to part of an existing file, use edit_file.",
    inputSchema: {
      type: "object",
      properties: { path: pathProperty, content: { type: "string", description: "The complete new file content." } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  edit_file: {
    description:
      "Replace one exact text span in an existing file. old_text must match exactly one location: " +
      "include enough surrounding text to make it unique.",
    inputSchema: {
      type: "object",
      properties: {
        path: pathProperty,
        old_text: { type: "string", description: "The exact current text to replace (non-empty)." },
        new_text: { type: "string", description: "The replacement text." },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
  list_directory: {
    description: `List files and directories under a path; directories end in "/". Depth defaults to ${DEFAULT_LIST_DEPTH}.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to the workspace root; defaults to the root." },
        depth: { type: "integer", minimum: 1, maximum: MAX_LIST_DEPTH, description: "How many levels to descend." },
      },
      additionalProperties: false,
    },
  },
  search_codebase: {
    description:
      "Search file contents recursively with an extended regular expression. " +
      'Returns matching lines as "<path>:<line>:<text>".',
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Extended regular expression (non-empty)." },
        path: { type: "string", description: "Directory or file to search; defaults to the workspace root." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  run_command: {
    description:
      "Run a shell command in the workspace root and return its exit code, stdout and stderr. " +
      "Use it for build, test and other shell operations, not to read, write or search files.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command." },
        timeout_seconds: { type: "integer", minimum: 1, description: "Optional; capped by the attempt's per-command limit." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  finish: {
    description:
      'End the attempt. status "done": every deliverable exists and passes its checks. ' +
      'status "blocked": you cannot proceed; blockedReason says what is missing.',
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["done", "blocked"] },
        summary: { type: "string", description: "What you changed, in 1-2 sentences." },
        blockedReason: { type: "string", description: 'Required when status is "blocked".' },
      },
      required: ["status", "summary"],
      additionalProperties: false,
    },
  },
};

/** Only an attempt that builds the environment is given it (the "build-environment" tool profile). */
const BUILD_ENVIRONMENT_SCHEMA: TurnToolSchema = {
  description:
    "Build the environment defined in environment/environment.toml from the workspace's current files, then run " +
    "its probe command on a fresh checkout of those files in a workspace started from the built image. Refuses " +
    "work that touches a path outside the recipe. Returns the environment version, the image build log, the " +
    "probe's output and the verdict. Only the image build can reach the network.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

/** Environment work's finish: a done carries the stack statement, which is what the client is told. */
const ENVIRONMENT_FINISH_SCHEMA: TurnToolSchema = {
  description:
    'End the attempt. status "done": build_environment reported PASSED on the files as they are. ' +
    'status "blocked": you cannot proceed; blockedReason says what is missing.',
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["done", "blocked"] },
      summary: { type: "string", description: "What you changed, in 1-2 sentences." },
      statement: {
        type: "string",
        maxLength: MAX_STATEMENT_CHARS,
        description:
          'Required when status is "done": one paragraph stating the stack you chose (language, toolchain, base ' +
          "image) and why, and how the product is built and tested with it (the definition's build and test " +
          "commands, which the product's first task makes pass). The probe only proves the toolchain is present; " +
          "product behaviour is verified by the check author's checks. It is shown to the client: no file list, no " +
          "list of changes.",
      },
      blockedReason: { type: "string", description: 'Required when status is "blocked".' },
    },
    required: ["status", "summary"],
    additionalProperties: false,
  },
};

/** Only the check author defines checks (the work kind needing "author-checks"). */
const DEFINE_CHECK_SCHEMA: TurnToolSchema = {
  description:
    "Define one check of the task. " +
    CHECK_RUNNER +
    " The check passes when the command exits 0 and prints output. " +
    CHECK_VERDICT +
    ` At least one check must FAIL on the plan's foundation, by exiting ${CHECK_MISSING_EXIT} within its time limit, for ` +
    "the reason the task's work is missing; a check that fails there with any other exit is rejected. Any file a " +
    "check needs must be one you write in your checks directory (the Context names it): only those are kept with " +
    "the checks and written over the project whenever they run; a file you write anywhere else is discarded. A check " +
    "that changes a file the project tracks is rejected. The check is red-run at once on the foundation, with your " +
    "check files so far written over it; the result shows its exit code and output and whether it would be " +
    "rejected. Defining a check with the name of one already defined replaces it. Every check defined is kept as " +
    "an acceptance check of the task: never define one to look around; use probe_foundation for that. In " +
    "\"decides\" name the ids of the vision items the task cites that this check's verdict decides: a check that " +
    "fails when the product breaks what the item asks for. The checks are kept only when every item the task cites " +
    "is decided by at least one of them.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: MAX_CHECK_NAME, description: "A short name, unique among this task's checks." },
      command: { type: "string", description: "The shell command." },
      decides: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "The ids of the vision items the task cites that this check decides, exactly as the task lists them.",
      },
    },
    required: ["name", "command", "decides"],
    additionalProperties: false,
  },
};

/** Beside define_check: a look at the foundation that is never kept as a check. */
const PROBE_FOUNDATION_SCHEMA: TurnToolSchema = {
  description:
    "Run one shell command on the plan's foundation, exactly where define_check red-runs a check (your check " +
    "files so far written over it), and see its exit code and output. Nothing is recorded: it defines no check. " +
    "Use it to look at the foundation (which files exist there, how the product starts or refuses) before you " +
    "define the checks. " +
    CHECK_RUNNER,
  inputSchema: {
    type: "object",
    properties: { command: { type: "string", description: "The shell command." } },
    required: ["command"],
    additionalProperties: false,
  },
};

/** Only a task decided by stored checks runs them (Z0 supplies the port exactly then). */
const RUN_CHECKS_SCHEMA: TurnToolSchema = {
  description:
    "Run the checks that decide this task on your current work, as verification will: their stored files are " +
    "written over a copy of the workspace and each check runs from its root in a fresh workspace of the project " +
    "environment. Returns each check's verdict, exit code and the end of its output. Your workspace is not changed.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

/**
 * Only implementation work decided by stored checks may dispute one (ADR-074 addendum 2 d65 c): one
 * of its own, or one of an already merged task's that verification also runs on its merge (d74 D).
 */
const DISPUTE_CHECK_SCHEMA: TurnToolSchema = {
  description:
    "End the attempt by disputing one check that blocks your merge: one of the task's own checks, or a check of a " +
    "task already merged that verification also runs. Use it only when that check cannot pass on correct work (for " +
    "example the check itself is broken or contradicts the task), never because your work does not pass it yet. The " +
    "check goes back to its author with your reason and the output of your last run_checks; this task waits until " +
    "the checks are written again. Your work so far is kept for the next attempt.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: MAX_CHECK_NAME, description: "The disputed check's name, exactly as run_checks or verification reports it." },
      task: {
        type: "string",
        description: "For a check of a task already merged: that task's id, as verification names it. Omit it for this task's own checks.",
      },
      reason: {
        type: "string",
        maxLength: MAX_DISPUTE_REASON_CHARS,
        description: "Why the check cannot pass on correct work, with the evidence you found.",
      },
    },
    required: ["name", "reason"],
    additionalProperties: false,
  },
};

/**
 * The tools an attempt offers the model: build_environment only for the "build-environment" profile,
 * define_check only for "define-checks", run_checks only when the task's stored checks can be run,
 * and dispute_check only for "run-and-dispute-checks" when it runs them.
 */
export function toolSchemasFor(toolProfile: ToolProfile, runChecks: boolean): ToolSchemas {
  const offered = runChecks ? { ...TOOL_SCHEMAS, run_checks: RUN_CHECKS_SCHEMA } : TOOL_SCHEMAS;
  switch (toolProfile) {
    case "build-environment":
      return { ...offered, build_environment: BUILD_ENVIRONMENT_SCHEMA, finish: ENVIRONMENT_FINISH_SCHEMA };
    case "define-checks":
      return { ...offered, define_check: DEFINE_CHECK_SCHEMA, probe_foundation: PROBE_FOUNDATION_SCHEMA };
    case "run-and-dispute-checks":
      return runChecks ? { ...offered, dispute_check: DISPUTE_CHECK_SCHEMA } : offered;
    case "run-checks":
      return offered;
  }
}

type ToolExecution =
  | { readonly kind: "result"; readonly output: string; readonly isError: boolean }
  | { readonly kind: "finish"; readonly args: FinishArgs }
  | { readonly kind: "dispute"; readonly checkName: string; readonly ofTask: string | null; readonly reason: string }
  | { readonly kind: "environment_failure"; readonly error: unknown; readonly toolName: string };

interface ToolContext {
  readonly cell: CellBackend;
  /** The per-command bound for this call: the attempt's limit, cut further by the wall clock left. */
  readonly commandTimeoutSeconds: number;
  /** The tools offered to the model this attempt; a call to any other is refused. */
  readonly tools: ToolSchemas;
  /** Z0's environment check; non-null exactly when the tools include build_environment. */
  readonly environment: EnvironmentCheckPort | null;
  /** Z0's check recorder; non-null exactly when the tools include define_check. */
  readonly checks: CheckDefinitionPort | null;
  /** Z0's run of the stored checks; non-null exactly when the tools include run_checks. */
  readonly taskChecks: TaskCheckRunPort | null;
}

/**
 * A tool's execution before the conversation's bound: a result's output may already carry the output caps' cuts,
 * which the bound then counts together with its own.
 */
type RanTool = Exclude<ToolExecution, { readonly kind: "result" }> | { readonly kind: "result"; readonly output: ElidedText; readonly isError: boolean };

function result(output: string, isError: boolean): RanTool {
  return { kind: "result", output: wholeText(output), isError };
}

function toolError(message: string): RanTool {
  return result(message, true);
}

function ok(output: ElidedText): RanTool {
  return { kind: "result", output, isError: false };
}

function argsError(toolName: string, error: z.ZodError): RanTool {
  const issues = error.issues.map((issue) => `${issue.path.join(".") || "(arguments)"}: ${issue.message}`);
  return toolError(`Invalid arguments for ${toolName}: ${issues.join("; ")}. Fix the arguments and call it again.`);
}

/**
 * A cell error the model can act on (a bad path, a missing file, a utility's own non-zero exit) is
 * a tool error; anything else means the substrate failed, which the model cannot fix.
 */
function classifyCellError(toolName: string, error: unknown): RanTool {
  if (error instanceof PathOutsideWorkspace || error instanceof InvalidCellRequest) return toolError(error.message);
  if (error instanceof CellToolFailed && error.exitCode !== null) {
    return toolError(`${toolName} failed (exit ${error.exitCode}${error.timedOut ? ", timed out" : ""}): ${error.stderr.trim() || "(no stderr)"}`);
  }
  return { kind: "environment_failure", error, toolName };
}

const STATUS_LOST =
  "Exit status unknown: the process running this command was killed before it reported how the command ended. " +
  "A command that kills processes by pattern (pkill -f, kill $(pgrep -f ...)) can match the shell running it. " +
  "Everything the command left running was stopped; the workspace is intact.";

function formatRun(run: ExecResult, timeoutSeconds: number): RanTool {
  const parts: ElidedText[] = [
    wholeText(
      run.statusLost
        ? STATUS_LOST
        : run.timedOut
          ? `Timed out after ${timeoutSeconds}s and was killed (exit ${run.exitCode})`
          : `Exit code: ${run.exitCode}`,
    ),
  ];
  if (run.stdout !== "") parts.push(wholeText("\nSTDOUT:\n"), elidedOutput(run.stdout, run.stdoutCut));
  if (run.stderr !== "") parts.push(wholeText("\nSTDERR:\n"), elidedOutput(run.stderr, run.stderrCut));
  return { kind: "result", output: joinElided(parts), isError: run.statusLost || run.timedOut || run.exitCode !== 0 };
}

/** define_check's answer: what was recorded and how its immediate red run on main went. */
function formatDefinedCheck(name: string, defined: Extract<CheckDefinitionResult, { readonly kind: "recorded" }>): RanTool {
  const discarded =
    defined.discarded.length === 0
      ? []
      : [
          `Discarded, outside your checks directory (not kept, not placed on the foundation): ${defined.discarded.join(", ")}.`,
        ];
  const undecided =
    defined.undecided.length === 0
      ? `Every item the task cites is decided by a check defined so far.`
      : `Cited items no check defined so far decides (the checks are not kept until each has one): ${defined.undecided.join(", ")}.`;
  const recorded = [`${defined.replaced ? "Replaced" : "Defined"} check ${JSON.stringify(name)} (${defined.defined} defined so far).`, undecided, ...discarded].join("\n");
  const { redRun } = defined;
  if (redRun.kind === "files_refused" || redRun.kind === "product_changed") {
    return toolError(`${recorded}\nIt could not be red-run: ${redRun.detail}\nAt finish this rejects every check of the task.`);
  }
  const { run } = redRun;
  const lines = [
    recorded,
    `Red run on the plan's foundation (limit ${redRun.timeoutSeconds}s):`,
    `  exit code: ${run.exitCode ?? "none (killed)"}${run.timedOut ? " (timed out)" : ""}`,
    `  output: ${run.output === "" ? "(empty)" : run.output}`,
    redRun.rejection !== null
      ? `WOULD BE REJECTED at finish: ${redRun.rejection}. Fix it and define it again under the same name.`
      : redRun.holdsAlready
        ? `It passes on the foundation: it is kept as a guard of behaviour that already holds there. At finish at ` +
          `least one check of the set must fail on the foundation for the reason the task's work is missing.`
        : `It fails on the foundation. Make sure it fails for the reason the task's work is missing, not because of a ` +
          `syntax error or a file that does not exist: such a check can never pass.`,
  ];
  return result(lines.join("\n"), redRun.rejection !== null);
}

/** probe_foundation's answer: the command's run on the foundation; nothing was recorded. */
function formatFoundationProbe(probe: FoundationProbe): RanTool {
  if (probe.kind !== "ran") return toolError(`It could not run on the foundation: ${probe.detail}\nNothing was recorded.`);
  const { run } = probe;
  return result(
    [
      `Run on the plan's foundation (limit ${probe.timeoutSeconds}s); no check was defined:`,
      `  exit code: ${run.exitCode ?? "none (killed)"}${run.timedOut ? " (timed out)" : ""}`,
      `  output: ${run.output === "" ? "(empty)" : run.output}`,
    ].join("\n"),
    run.timedOut || run.exitCode !== 0,
  );
}

function countOccurrences(text: string, needle: string): { readonly count: number; readonly first: number } {
  let count = 0;
  let first = -1;
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index === -1) return { count, first };
    if (count === 0) first = index;
    count += 1;
    from = index + needle.length;
  }
}

async function runTool(toolName: string, input: unknown, context: ToolContext): Promise<RanTool> {
  const { cell } = context;
  if (!Object.hasOwn(context.tools, toolName)) {
    return toolError(`Unknown tool "${toolName}". Available tools: ${Object.keys(context.tools).join(", ")}.`);
  }
  switch (toolName) {
    case "read_file": {
      const args = readFileArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      const file = await cell.readFile(args.data.path);
      return ok(file);
    }
    case "write_file": {
      const args = writeFileArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      await cell.writeFile(args.data.path, args.data.content);
      context.checks?.fileWritten(args.data.path);
      return ok(wholeText(`Wrote ${args.data.path} (${args.data.content.length} characters).`));
    }
    case "edit_file": {
      const args = editFileArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      const { path, old_text: oldText, new_text: newText } = args.data;
      const text = uncutText(await cell.readFile(path));
      if (text === null) return toolError(`${path} is larger than the workspace read limit; edit_file cannot rewrite it safely.`);
      const { count, first } = countOccurrences(text, oldText);
      if (count === 0) return toolError(`old_text not found in ${path}. Read the file and copy the exact text.`);
      if (count > 1) return toolError(`old_text matches ${count} locations in ${path}. Include more surrounding text.`);
      // Spliced by index: String.replace would interpret `$&` and `$1` in new_text.
      await cell.writeFile(path, text.slice(0, first) + newText + text.slice(first + oldText.length));
      context.checks?.fileWritten(path);
      return ok(wholeText(`Edited ${path}: replaced ${oldText.split("\n").length} line(s) with ${newText.split("\n").length} line(s).`));
    }
    case "list_directory": {
      const args = listDirectoryArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      const listing = await cell.listDirectory(args.data.path ?? ".", args.data.depth ?? DEFAULT_LIST_DEPTH);
      return ok(uncutText(listing) === "" ? wholeText("(empty)") : listing);
    }
    case "search_codebase": {
      const args = searchArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      const found = await cell.search(args.data.pattern, args.data.path ?? ".");
      return ok(uncutText(found)?.trim() === "" ? wholeText("No matches.") : found);
    }
    case "run_command": {
      const args = runCommandArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      const timeoutSeconds = Math.min(args.data.timeout_seconds ?? context.commandTimeoutSeconds, context.commandTimeoutSeconds);
      const result = await cell.run(args.data.command, timeoutSeconds);
      // A null exit code without a lost status means the host backstop killed the podman client:
      // the substrate hung, not the command.
      if (result.exitCode === null && !result.statusLost) {
        return {
          kind: "environment_failure",
          toolName,
          error: new CellToolFailed("run", ["sh", "-c", args.data.command], null, result.stderr, result.timedOut),
        };
      }
      return formatRun(result, timeoutSeconds);
    }
    case "build_environment": {
      const args = buildEnvironmentArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      if (context.environment === null) return toolError(`build_environment is not available in this attempt.`);
      const verdict = await context.environment.check(context.commandTimeoutSeconds);
      return result(verdict.report, !verdict.passed);
    }
    case "define_check": {
      const args = defineCheckArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      if (context.checks === null) return toolError(`define_check is not available in this attempt.`);
      const name = args.data.name.trim();
      const result = await context.checks.define({ name, command: args.data.command, decides: args.data.decides }, context.commandTimeoutSeconds);
      if (result.kind === "refused") return toolError(`define_check refused: ${result.reason}`);
      return formatDefinedCheck(name, result);
    }
    case "probe_foundation": {
      const args = probeFoundationArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      if (context.checks === null) return toolError(`probe_foundation is not available in this attempt.`);
      return formatFoundationProbe(await context.checks.probe(args.data.command, context.commandTimeoutSeconds));
    }
    case "run_checks": {
      const args = runChecksArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      if (context.taskChecks === null) return toolError(`run_checks is not available in this attempt.`);
      const verdict = await context.taskChecks.run(context.commandTimeoutSeconds);
      return result(verdict.report, !verdict.passed);
    }
    case "dispute_check": {
      const args = disputeCheckArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      if (context.taskChecks === null) return toolError(`dispute_check is not available in this attempt.`);
      const name = args.data.name.trim();
      const reason = args.data.reason.trim();
      const ofTask = args.data.task?.trim();
      if (ofTask !== undefined) {
        const merged = context.taskChecks.mergedChecks;
        if (!merged.some((check) => check.taskId === ofTask && check.name === name)) {
          const known = merged.filter((check) => check.taskId === ofTask).map((check) => JSON.stringify(check.name));
          return toolError(
            known.length === 0
              ? `dispute_check: no task already merged has id ${JSON.stringify(ofTask)} with stored checks.`
              : `dispute_check: task ${ofTask} has no check named ${JSON.stringify(name)}. Its checks are: ${known.join(", ")}.`,
          );
        }
        return { kind: "dispute", checkName: name, ofTask, reason };
      }
      if (!context.taskChecks.checkNames.includes(name)) {
        const known = context.taskChecks.checkNames.map((check) => JSON.stringify(check)).join(", ");
        return toolError(
          `dispute_check: no check of this task is named ${JSON.stringify(name)}. Its checks are: ${known}. For a check of a ` +
            `task already merged, give that task's id as "task".`,
        );
      }
      return { kind: "dispute", checkName: name, ofTask: null, reason };
    }
    case "finish": {
      // The finish parsed is the finish offered: environment work's carries the statement.
      const args = (context.tools.finish === ENVIRONMENT_FINISH_SCHEMA ? environmentFinishArgs : finishArgs).safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      return { kind: "finish", args: args.data };
    }
    default:
      return toolError(`Unknown tool "${toolName}". Available tools: ${Object.keys(context.tools).join(", ")}.`);
  }
}

/** Executes one tool call through the cell. Never touches the host filesystem. */
export async function executeTool(toolName: string, input: unknown, context: ToolContext): Promise<ToolExecution> {
  let execution: RanTool;
  try {
    execution = await runTool(toolName, input, context);
  } catch (error) {
    execution = classifyCellError(toolName, error);
  }
  return execution.kind === "result" ? { ...execution, output: truncateElided(execution.output) } : execution;
}

import { z } from "zod";
import { CellToolFailed, InvalidCellRequest, PathOutsideWorkspace } from "@ashara/execution-infra";
import type { CellBackend, ExecResult } from "@ashara/execution-infra";
import type { TurnToolSchema } from "@ashara/llm-gateway";
import type { WorkKind } from "@ashara/shared";
import { environmentCheckPassed, formatEnvironmentCheck } from "./environment-check.js";
import type { EnvironmentCheckPort } from "./environment-check.js";
import { truncateText } from "./records.js";

const MAX_LIST_DEPTH = 5;
const DEFAULT_LIST_DEPTH = 2;

const nonEmpty = z.string().min(1);

const readFileArgs = z.object({ path: nonEmpty }).strict();
const writeFileArgs = z.object({ path: nonEmpty, content: z.string() }).strict();
const editFileArgs = z.object({ path: nonEmpty, old_text: nonEmpty, new_text: z.string() }).strict();
const listDirectoryArgs = z
  .object({ path: nonEmpty.optional(), depth: z.number().int().min(1).max(MAX_LIST_DEPTH).optional() })
  .strict();
const searchArgs = z.object({ pattern: nonEmpty, path: nonEmpty.optional() }).strict();
const runCommandArgs = z.object({ command: nonEmpty, timeout_seconds: z.number().int().positive().optional() }).strict();
const buildEnvironmentArgs = z.object({}).strict();
const finishArgs = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), summary: nonEmpty }).strict(),
  z.object({ status: z.literal("blocked"), summary: nonEmpty, blockedReason: nonEmpty }).strict(),
]);

type FinishArgs = z.infer<typeof finishArgs>;

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

/** Only the role that defines the environment can build it (the work kind needing "write-environment"). */
const BUILD_ENVIRONMENT_SCHEMA: TurnToolSchema = {
  description:
    "Build the environment defined in environment/environment.toml from the workspace's current files, then run " +
    "its test command in a fresh workspace started from the built image. Returns the environment version, the " +
    "build log and the test output. Only the image build can reach the network.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

/** The tools an attempt offers the model: build_environment only for environment work. */
export function toolSchemasFor(workKind: WorkKind | null): ToolSchemas {
  return workKind === "environment" ? { ...TOOL_SCHEMAS, build_environment: BUILD_ENVIRONMENT_SCHEMA } : TOOL_SCHEMAS;
}

export type ToolExecution =
  | { readonly kind: "result"; readonly output: string; readonly isError: boolean }
  | { readonly kind: "finish"; readonly args: FinishArgs }
  | { readonly kind: "environment_failure"; readonly error: unknown; readonly toolName: string };

export interface ToolContext {
  readonly cell: CellBackend;
  /** The per-command bound for this call: the attempt's limit, cut further by the wall clock left. */
  readonly commandTimeoutSeconds: number;
  /** The tools offered to the model this attempt; a call to any other is refused. */
  readonly tools: ToolSchemas;
  /** Z0's environment check; non-null exactly when the tools include build_environment. */
  readonly environment: EnvironmentCheckPort | null;
}

function toolError(message: string): ToolExecution {
  return { kind: "result", output: message, isError: true };
}

function ok(output: string): ToolExecution {
  return { kind: "result", output, isError: false };
}

function argsError(toolName: string, error: z.ZodError): ToolExecution {
  const issues = error.issues.map((issue) => `${issue.path.join(".") || "(arguments)"}: ${issue.message}`);
  return toolError(`Invalid arguments for ${toolName}: ${issues.join("; ")}. Fix the arguments and call it again.`);
}

function withCellMarker(text: string, truncated: boolean): string {
  return truncated ? `${text}\n[truncated by the workspace: output exceeded its size limit]` : text;
}

/**
 * A cell error the model can act on (a bad path, a missing file, a utility's own non-zero exit) is
 * a tool error; anything else means the substrate failed, which the model cannot fix.
 */
function classifyCellError(toolName: string, error: unknown): ToolExecution {
  if (error instanceof PathOutsideWorkspace || error instanceof InvalidCellRequest) return toolError(error.message);
  if (error instanceof CellToolFailed && error.exitCode !== null) {
    return toolError(`${toolName} failed (exit ${error.exitCode}${error.timedOut ? ", timed out" : ""}): ${error.stderr.trim() || "(no stderr)"}`);
  }
  return { kind: "environment_failure", error, toolName };
}

function formatRun(result: ExecResult, timeoutSeconds: number): ToolExecution {
  const parts = [result.timedOut ? `Timed out after ${timeoutSeconds}s and was killed (exit ${result.exitCode})` : `Exit code: ${result.exitCode}`];
  if (result.stdout !== "") parts.push(`STDOUT:\n${withCellMarker(result.stdout, result.stdoutTruncated)}`);
  if (result.stderr !== "") parts.push(`STDERR:\n${withCellMarker(result.stderr, result.stderrTruncated)}`);
  return { kind: "result", output: parts.join("\n"), isError: result.timedOut || result.exitCode !== 0 };
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

async function runTool(toolName: string, input: unknown, context: ToolContext): Promise<ToolExecution> {
  const { cell } = context;
  if (!Object.hasOwn(context.tools, toolName)) {
    return toolError(`Unknown tool "${toolName}". Available tools: ${Object.keys(context.tools).join(", ")}.`);
  }
  switch (toolName) {
    case "read_file": {
      const args = readFileArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      const file = await cell.readFile(args.data.path);
      return ok(withCellMarker(file.text, file.truncated));
    }
    case "write_file": {
      const args = writeFileArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      await cell.writeFile(args.data.path, args.data.content);
      return ok(`Wrote ${args.data.path} (${args.data.content.length} characters).`);
    }
    case "edit_file": {
      const args = editFileArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      const { path, old_text: oldText, new_text: newText } = args.data;
      const file = await cell.readFile(path);
      if (file.truncated) return toolError(`${path} is larger than the workspace read limit; edit_file cannot rewrite it safely.`);
      const { count, first } = countOccurrences(file.text, oldText);
      if (count === 0) return toolError(`old_text not found in ${path}. Read the file and copy the exact text.`);
      if (count > 1) return toolError(`old_text matches ${count} locations in ${path}. Include more surrounding text.`);
      // Spliced by index: String.replace would interpret `$&` and `$1` in new_text.
      await cell.writeFile(path, file.text.slice(0, first) + newText + file.text.slice(first + oldText.length));
      return ok(`Edited ${path}: replaced ${oldText.split("\n").length} line(s) with ${newText.split("\n").length} line(s).`);
    }
    case "list_directory": {
      const args = listDirectoryArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      const listing = await cell.listDirectory(args.data.path ?? ".", args.data.depth ?? DEFAULT_LIST_DEPTH);
      const text = listing.entries.length === 0 ? "(empty)" : listing.entries.join("\n");
      return ok(withCellMarker(text, listing.truncated));
    }
    case "search_codebase": {
      const args = searchArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      const found = await cell.search(args.data.pattern, args.data.path ?? ".");
      const text = found.text.trim() === "" ? "No matches." : found.text;
      return ok(withCellMarker(text, found.truncated));
    }
    case "run_command": {
      const args = runCommandArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      const timeoutSeconds = Math.min(args.data.timeout_seconds ?? context.commandTimeoutSeconds, context.commandTimeoutSeconds);
      const result = await cell.run(args.data.command, timeoutSeconds);
      // A null exit code means the host backstop killed the podman client: the substrate hung, not the command.
      if (result.exitCode === null) {
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
      const report = await context.environment.check(context.commandTimeoutSeconds);
      return { kind: "result", output: formatEnvironmentCheck(report), isError: !environmentCheckPassed(report) };
    }
    case "finish": {
      const args = finishArgs.safeParse(input);
      if (!args.success) return argsError(toolName, args.error);
      return { kind: "finish", args: args.data };
    }
    default:
      return toolError(`Unknown tool "${toolName}". Available tools: ${Object.keys(context.tools).join(", ")}.`);
  }
}

/** Executes one tool call through the cell. Never touches the host filesystem. */
export async function executeTool(toolName: string, input: unknown, context: ToolContext): Promise<ToolExecution> {
  let execution: ToolExecution;
  try {
    execution = await runTool(toolName, input, context);
  } catch (error) {
    return classifyCellError(toolName, error);
  }
  return execution.kind === "result" ? { ...execution, output: truncateText(execution.output) } : execution;
}

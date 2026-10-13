import { CellToolFailed, InvalidCellRequest } from "./errors.js";
import type { Cell, ExecResult } from "./podman.js";
import { stripDotSlash, toWorkspaceRelative } from "./workspace-path.js";

interface TextOutput {
  readonly text: string;
  readonly truncated: boolean;
}

interface Listing {
  /** Workspace-relative paths; directories end in "/". Sorted. */
  readonly entries: readonly string[];
  readonly truncated: boolean;
}

/**
 * What Workplace tools need from a cell. Every method is one `podman exec` of a POSIX utility; paths
 * are workspace-relative and resolved inside the cell. There is no host implementation.
 */
export interface CellBackend {
  readFile(path: string): Promise<TextOutput>;
  writeFile(path: string, content: string): Promise<void>;
  listDirectory(path: string, depth: number): Promise<Listing>;
  /** Extended regular expression, recursive under `path`; lines are "<path>:<line>:<text>". */
  search(pattern: string, path: string): Promise<TextOutput>;
  /** `sh -c <command>` under `timeout`; the result is the command's, whatever its exit code. */
  run(command: string, timeoutSeconds: number): Promise<ExecResult>;
}

export interface CellBackendOptions {
  /** Timeout for the file tools (read, write, list, search). */
  readonly toolTimeoutSeconds: number;
}

// `"$1"` is the path argument, never interpolated into the script.
const WRITE_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';

export function createCellBackend(cell: Pick<Cell, "exec">, options: CellBackendOptions): CellBackend {
  const timeoutSeconds = options.toolTimeoutSeconds;

  async function tool(name: string, argv: readonly string[], okExitCodes: readonly number[], stdin?: string): Promise<ExecResult> {
    const result = await cell.exec(argv, { timeoutSeconds, ...(stdin === undefined ? {} : { stdin }) });
    if (result.timedOut || result.exitCode === null || !okExitCodes.includes(result.exitCode)) {
      throw new CellToolFailed(name, argv, result.exitCode, result.stderr, result.timedOut);
    }
    return result;
  }

  return {
    async readFile(path) {
      const result = await tool("readFile", ["cat", "--", toWorkspaceRelative(path)], [0]);
      return { text: result.stdout, truncated: result.stdoutTruncated };
    },

    async writeFile(path, content) {
      const target = toWorkspaceRelative(path);
      if (target === ".") throw new InvalidCellRequest("writeFile", ["path names the workspace root, not a file"]);
      await tool("writeFile", ["sh", "-c", WRITE_SCRIPT, "sh", target], [0], content);
    },

    async listDirectory(path, depth) {
      if (!Number.isInteger(depth) || depth < 1) {
        throw new InvalidCellRequest("listDirectory", [`depth must be a positive integer, got ${depth}`]);
      }
      const argv = [
        "find", "--", toWorkspaceRelative(path), "-mindepth", "1", "-maxdepth", String(depth),
        "-type", "d", "-exec", "printf", "%s/\\n", "{}", "+", "-o", "-print",
      ];
      const result = await tool("listDirectory", argv, [0]);
      const entries = result.stdout.split("\n").filter((line) => line !== "").map(stripDotSlash).sort();
      return { entries, truncated: result.stdoutTruncated };
    },

    async search(pattern, path) {
      if (pattern === "") throw new InvalidCellRequest("search", ["pattern must not be empty"]);
      // grep exits 1 for "no match", which is an answer, not a failure.
      const result = await tool("search", ["grep", "-rn", "-E", "-e", pattern, "--", toWorkspaceRelative(path)], [0, 1]);
      const text = result.stdout.split("\n").map(stripDotSlash).join("\n");
      return { text, truncated: result.stdoutTruncated };
    },

    async run(command, runTimeoutSeconds) {
      if (command.trim() === "") throw new InvalidCellRequest("run", ["command must not be empty"]);
      // No setsid: it would move the command out of timeout's process group, and timeout's
      // group kill is what reaches background children when the time runs out.
      return cell.exec(["sh", "-c", command], { timeoutSeconds: runTimeoutSeconds });
    },
  };
}

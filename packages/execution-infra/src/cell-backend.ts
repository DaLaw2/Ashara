import { joinElided, wholeText } from "@ashara/shared";
import type { ElidedText } from "@ashara/shared";
import { CellToolFailed, InvalidCellRequest } from "./errors.js";
import type { Cell, ExecResult } from "./podman.js";
import { elidedOutput } from "./process-runner.js";
import { stripDotSlash, toWorkspaceRelative } from "./workspace-path.js";

/**
 * A utility's line output with each line's leading "./" stripped and, when `sort`, the lines sorted. Past the output
 * cap the middle was cut: a line split by the cut is dropped whole and counted with it, and the lines on each side
 * are sorted on their own. Counts are of the characters the utility printed.
 */
function lineOutput(result: ExecResult, sort: boolean): ElidedText {
  const pieces = elidedOutput(result.stdout, result.stdoutCut);
  const out: ElidedText[] = [];
  pieces.forEach((piece, i) => {
    if (piece.kind === "cut") {
      out.push([piece]);
      return;
    }
    let text = piece.text;
    let before = 0;
    let after = 0;
    if (i > 0) {
      const firstBreak = text.indexOf("\n");
      before = firstBreak === -1 ? text.length : firstBreak + 1;
      text = text.slice(before);
    }
    if (i < pieces.length - 1) {
      after = text.length - (text.lastIndexOf("\n") + 1);
      text = text.slice(0, text.length - after);
    }
    const lines = text.split("\n").filter((line) => line !== "").map(stripDotSlash);
    if (sort) lines.sort();
    const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    out.push([{ kind: "cut", chars: before }], wholeText(body), [{ kind: "cut", chars: after }]);
  });
  return joinElided(out);
}

/**
 * What Workplace tools need from a cell. Every method is one `podman exec` of a POSIX utility; paths
 * are workspace-relative and resolved inside the cell. There is no host implementation.
 */
export interface CellBackend {
  readFile(path: string): Promise<ElidedText>;
  writeFile(path: string, content: string): Promise<void>;
  /** Workspace-relative paths, one per line; directories end in "/". Sorted. */
  listDirectory(path: string, depth: number): Promise<ElidedText>;
  /** Extended regular expression, recursive under `path`; lines are "<path>:<line>:<text>". */
  search(pattern: string, path: string): Promise<ElidedText>;
  /** `sh -c <command>` under `timeout`; the result is the command's, whatever its exit code. */
  run(command: string, timeoutSeconds: number): Promise<ExecResult>;
}

interface CellBackendOptions {
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
      return elidedOutput(result.stdout, result.stdoutCut);
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
      return lineOutput(result, true);
    },

    async search(pattern, path) {
      if (pattern === "") throw new InvalidCellRequest("search", ["pattern must not be empty"]);
      // grep exits 1 for "no match", which is an answer, not a failure.
      const result = await tool("search", ["grep", "-rn", "-E", "-e", pattern, "--", toWorkspaceRelative(path)], [0, 1]);
      return lineOutput(result, false);
    },

    async run(command, runTimeoutSeconds) {
      if (command.trim() === "") throw new InvalidCellRequest("run", ["command must not be empty"]);
      // No setsid: it would move the command out of timeout's process group, and timeout's
      // group kill is what reaches background children when the time runs out.
      return cell.exec(["sh", "-c", command], { timeoutSeconds: runTimeoutSeconds });
    },
  };
}

import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { ProcessSpawnFailed } from "./errors.js";

export interface ProcessRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Written to the child's stdin, which is then closed. Absent: stdin is closed at once. */
  readonly stdin?: string | Buffer;
  /** Host-side backstop: SIGKILL the child after this long. */
  readonly killAfterMs?: number;
  readonly maxOutputBytes: number;
  /**
   * Policy default false. True opens a fourth pipe, the child's fd 3, read into `statusReport`:
   * a channel the child's stdout and stderr cannot reach and output caps cannot truncate.
   */
  readonly statusChannel?: boolean;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
  readonly killedByHost: boolean;
  /** Writing stdin failed (e.g. EPIPE because the child exited without reading it). */
  readonly stdinError: string | null;
  /** What the child wrote to fd 3 ("" when nothing); null when no status channel was requested. */
  readonly statusReport: string | null;
}

/** Runs one binary with an argv array; never a shell. Rejects only with ProcessSpawnFailed. */
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

class CappedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    const room = this.max - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (kept.length < chunk.length) this.truncated = true;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** A status report is a few bytes; anything longer is not one, and is cut here. */
const MAX_STATUS_BYTES = 64;

export const spawnProcess: ProcessRunner = (request) =>
  new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(request.file, [...request.args], {
      env: { ...request.env },
      stdio: request.statusChannel === true ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const statusStream = request.statusChannel === true ? child.stdio[3] : null;
    const status = new CappedBuffer(MAX_STATUS_BYTES);
    if (statusStream instanceof Readable) statusStream.on("data", (chunk: Buffer) => status.push(chunk));
    const stdout = new CappedBuffer(request.maxOutputBytes);
    const stderr = new CappedBuffer(request.maxOutputBytes);
    let killedByHost = false;
    let stdinError: string | null = null;
    let settled = false;

    const timer =
      request.killAfterMs === undefined
        ? undefined
        : setTimeout(() => {
            killedByHost = true;
            child.kill("SIGKILL");
          }, request.killAfterMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", (err: Error) => {
      stdinError = err.message;
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new ProcessSpawnFailed(request.file, err.code ?? "unknown", err.message, { cause: err }));
    });

    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        exitCode,
        signal,
        stdout: stdout.text(),
        stdoutTruncated: stdout.truncated,
        stderr: stderr.text(),
        stderrTruncated: stderr.truncated,
        killedByHost,
        stdinError,
        statusReport: statusStream instanceof Readable ? status.text() : null,
      });
    });

    if (request.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(request.stdin);
    }
  });

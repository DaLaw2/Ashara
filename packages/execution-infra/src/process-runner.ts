import { spawn } from "node:child_process";
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

export const spawnProcess: ProcessRunner = (request) =>
  new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(request.file, [...request.args], {
      env: { ...request.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
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
      });
    });

    if (request.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(request.stdin);
    }
  });

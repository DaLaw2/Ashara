import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { headBudget, joinElided, renderElided, wholeText } from "@ashara/shared";
import type { ElidedText } from "@ashara/shared";
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
  /** What was kept of stdout; when its middle was cut, stdoutCut says where and how much. */
  readonly stdout: string;
  readonly stdoutCut: StreamCut | null;
  readonly stderr: string;
  readonly stderrCut: StreamCut | null;
  readonly killedByHost: boolean;
  /** Writing stdin failed (e.g. EPIPE because the child exited without reading it). */
  readonly stdinError: string | null;
  /** What the child wrote to fd 3 ("" when nothing); null when no status channel was requested. */
  readonly statusReport: string | null;
}

/** Runs one binary with an argv array; never a shell. Rejects only with ProcessSpawnFailed. */
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

/** Where a capped stream's middle was cut: `at` is the index in its text, `chars` the characters cut there. */
export interface StreamCut {
  readonly at: number;
  readonly chars: number;
}

/** A capped stream's text as an ElidedText, its cut (if any) in place. */
export function elidedOutput(text: string, cut: StreamCut | null): ElidedText {
  if (cut === null) return wholeText(text);
  return joinElided([wholeText(text.slice(0, cut.at)), [{ kind: "cut", chars: cut.chars }], wholeText(text.slice(cut.at))]);
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * The UTF-16 length of `bytes` decoded as UTF-8, counted without decoding: one per lead byte, two for a 4-byte
 * sequence (a surrogate pair). Exact for valid UTF-8; an invalid byte counts as one character.
 */
function utf16Length(bytes: Buffer): number {
  let units = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (!isContinuation(byte)) units += byte >= 0xf0 ? 2 : 1;
  }
  return units;
}

/** Where `bytes` stops holding only whole UTF-8 sequences: the start of a last sequence that is incomplete. */
function wholeSequencesEnd(bytes: Buffer): number {
  for (let i = bytes.length - 1; i >= Math.max(0, bytes.length - 4); i--) {
    const byte = bytes[i];
    if (isContinuation(byte)) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return bytes.length - i < needed ? i : bytes.length;
  }
  return bytes.length;
}

/**
 * Keeps at most `max` bytes of a stream: its head and its (larger) tail, split as headBudget says. What falls between
 * them is dropped and counted in characters, so the text's reader can be told exactly how much is missing there.
 */
class CappedBuffer {
  private readonly head: Buffer[] = [];
  private headSize = 0;
  private tail: Buffer[] = [];
  private tailSize = 0;
  private readonly headMax: number;
  private readonly tailMax: number;
  private droppedBytes = 0;
  private droppedChars = 0;

  constructor(max: number) {
    this.headMax = headBudget(max);
    this.tailMax = max - this.headMax;
  }

  push(chunk: Buffer): void {
    const toHead = Math.min(this.headMax - this.headSize, chunk.length);
    if (toHead > 0) {
      this.head.push(chunk.subarray(0, toHead));
      this.headSize += toHead;
    }
    if (toHead === chunk.length) return;
    this.tail.push(chunk.subarray(toHead));
    this.tailSize += chunk.length - toHead;
    this.dropTailOverflow();
  }

  private drop(bytes: Buffer): void {
    this.droppedBytes += bytes.length;
    this.droppedChars += utf16Length(bytes);
  }

  private dropTailOverflow(): void {
    let excess = this.tailSize - this.tailMax;
    if (excess <= 0) return;
    this.tailSize = this.tailMax;
    const kept: Buffer[] = [];
    for (const piece of this.tail) {
      if (excess >= piece.length) {
        this.drop(piece);
        excess -= piece.length;
        continue;
      }
      if (excess > 0) this.drop(piece.subarray(0, excess));
      kept.push(excess > 0 ? piece.subarray(excess) : piece);
      excess = 0;
    }
    this.tail = kept;
  }

  /**
   * The text kept, and where its middle was cut. A cut never splits a character: the head's incomplete last
   * sequence and the tail's leading continuation bytes are counted with the cut, not decoded.
   */
  output(): { readonly text: string; readonly cut: StreamCut | null } {
    if (this.droppedBytes === 0) return { text: Buffer.concat([...this.head, ...this.tail]).toString("utf8"), cut: null };
    const head = Buffer.concat(this.head);
    const tail = Buffer.concat(this.tail);
    const headEnd = wholeSequencesEnd(head);
    let tailStart = 0;
    while (tailStart < Math.min(3, tail.length) && isContinuation(tail[tailStart])) tailStart++;
    const headText = head.subarray(0, headEnd).toString("utf8");
    return {
      text: headText + tail.subarray(tailStart).toString("utf8"),
      cut: { at: headText.length, chars: this.droppedChars + utf16Length(head.subarray(headEnd)) },
    };
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
      // eslint-disable-next-line no-restricted-syntax -- policy default: a spawn error without an errno code; the code is shown in messages only, no caller branches on it
      reject(new ProcessSpawnFailed(request.file, err.code ?? "unknown", err.message, { cause: err }));
    });

    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      const out = stdout.output();
      const err = stderr.output();
      const statusOutput = status.output();
      resolve({
        exitCode,
        signal,
        stdout: out.text,
        stdoutCut: out.cut,
        stderr: err.text,
        stderrCut: err.cut,
        killedByHost,
        stdinError,
        // A cut report carries its marker, so it never parses as a report.
        statusReport: statusStream instanceof Readable ? renderElided(elidedOutput(statusOutput.text, statusOutput.cut)) : null,
      });
    });

    if (request.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(request.stdin);
    }
  });

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import type { GitRunner } from "@ashara/execution-infra";
import { describeErrorChain } from "@ashara/shared";

/**
 * The broker's own program, plain CommonJS run by `node -e`: it execFiles each git invocation it
 * is sent and answers with execFile's result, its error's fields copied out. It is not TypeScript
 * on purpose: it loads no module of Ashara, so its process stays a few tens of MB.
 */
const BROKER_SOURCE = `
const { execFile } = require("node:child_process");
process.on("message", (request) => {
  const options = { cwd: request.cwd, env: request.env, encoding: request.bytes ? "buffer" : "utf8" };
  if (request.maxBuffer !== null) options.maxBuffer = request.maxBuffer;
  execFile("git", request.args, options, (error, stdout, stderr) => {
    const failure = error === null ? null : {
      message: error.message,
      code: error.code ?? null,
      killed: error.killed ?? null,
      signal: error.signal ?? null,
      cmd: error.cmd ?? null,
    };
    process.send({ id: request.id, failure, stdout, stderr });
  });
});
process.on("disconnect", () => process.exit(0));
`;

/** A broker that can no longer answer: it exited, or answered out of protocol. Fails every call it holds. */
class GitBrokerFailed extends Error {
  constructor(readonly detail: string) {
    super(`simulator git broker: ${detail}`);
    this.name = "GitBrokerFailed";
  }
}

const output = z.union([z.string(), z.instanceof(Uint8Array)]);
const replySchema = z.strictObject({
  id: z.number().int(),
  failure: z
    .strictObject({
      message: z.string(),
      code: z.union([z.number(), z.string()]).nullable(),
      killed: z.boolean().nullable(),
      signal: z.string().nullable(),
      cmd: z.string().nullable(),
    })
    .nullable(),
  stdout: output,
  stderr: output,
});
type Reply = z.infer<typeof replySchema>;

function asBuffer(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function asText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : asBuffer(value).toString();
}

/**
 * The host's git, spawned by a small helper process instead of the simulator's own: a mechanical
 * cost, not behaviour. A spawn from Node forks the spawning process, and the simulator's is a few
 * hundred MB, so each spawn blocks its event loop for the fork. The commands, their arguments, working directories and
 * environments are the
 * ones production passes, and a non-zero exit rejects as execFile's does: the error's message,
 * `code`, `killed`, `signal`, `cmd`, `stdout` and `stderr` are execFile's own.
 */
export class GitBroker {
  private readonly child: ChildProcess;
  private readonly pending = new Map<
    number,
    { readonly settle: (reply: Reply) => void; readonly fail: (err: GitBrokerFailed) => void }
  >();
  private nextId = 0;
  private broken: GitBrokerFailed | null = null;

  constructor() {
    this.child = spawn(process.execPath, ["-e", BROKER_SOURCE], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "advanced",
    });
    this.child.on("message", (raw: unknown) => {
      const reply = replySchema.safeParse(raw);
      const waiter = reply.success ? this.pending.get(reply.data.id) : undefined;
      if (!reply.success || waiter === undefined) {
        this.breakDown(
          `answered out of protocol: ${reply.success ? `unknown call ${reply.data.id}` : reply.error.message}`,
        );
        return;
      }
      this.pending.delete(reply.data.id);
      waiter.settle(reply.data);
    });
    this.child.on("error", (err) => this.breakDown(`failed: ${describeErrorChain(err)}`));
    this.child.on("exit", (code, signal) =>
      this.breakDown(`exited (code ${code ?? "none"}, signal ${signal ?? "none"})`),
    );
  }

  readonly runner: GitRunner = {
    text: async (invocation) => {
      const reply = await this.call(invocation, false);
      return { stdout: asText(reply.stdout), stderr: asText(reply.stderr) };
    },
    bytes: async (invocation) => asBuffer((await this.call(invocation, true)).stdout),
  };

  /** Ends the broker; a call still in flight then fails. */
  close(): void {
    this.breakDown("closed");
    if (this.child.connected) this.child.disconnect();
  }

  private breakDown(detail: string): void {
    if (this.broken === null) this.broken = new GitBrokerFailed(detail);
    for (const waiter of this.pending.values()) waiter.fail(this.broken);
    this.pending.clear();
    if (this.child.exitCode === null && this.child.signalCode === null && detail !== "closed")
      this.child.kill("SIGKILL");
  }

  private call(invocation: Parameters<GitRunner["text"]>[0], bytes: boolean): Promise<Reply> {
    return new Promise((resolve, reject) => {
      if (this.broken !== null) {
        reject(this.broken);
        return;
      }
      this.nextId += 1;
      const id = this.nextId;
      const settle = (reply: Reply): void => {
        if (reply.failure === null) {
          resolve(reply);
          return;
        }
        const out = bytes ? asBuffer(reply.stdout) : asText(reply.stdout);
        const err = bytes ? asBuffer(reply.stderr) : asText(reply.stderr);
        reject(
          /* eslint-disable-next-line no-restricted-syntax -- rebuilds execFile's own throw across the broker's process
             boundary: a plain Error with execFile's fields, which the product must meet as it is */
          Object.assign(new Error(reply.failure.message), {
            code: reply.failure.code,
            killed: reply.failure.killed,
            signal: reply.failure.signal,
            cmd: reply.failure.cmd,
            stdout: out,
            stderr: err,
          }),
        );
      };
      this.pending.set(id, { settle, fail: reject });
      // Absent `env` is the simulator's own environment as it stands now (simulatedEnvironment sets it per run), as
      // execFile's is.
      this.child.send({
        id,
        args: [...invocation.args],
        cwd: invocation.cwd,
        env: invocation.env ?? { ...process.env },
        maxBuffer: invocation.maxBuffer ?? null,
        bytes,
      });
    });
  }
}

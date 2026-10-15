import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileGitRunner } from "@ashara/execution-infra";
import { GitBroker } from "./git-broker.js";

const broker = new GitBroker();
let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ashara-git-broker-"));
  await execFileGitRunner.text({ args: ["init", "-q", "-b", "main", dir], cwd: dir });
});

afterAll(async () => {
  broker.close();
  await rm(dir, { recursive: true, force: true });
});

async function rejection(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  const err: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(err instanceof Error)) throw new Error(`expected a rejection, got ${String(err)}`);
  return { message: err.message, ...Object.fromEntries(["code", "killed", "signal", "cmd", "stdout", "stderr"].map((key) => [key, Reflect.get(err, key)])) };
}

describe("GitBroker", () => {
  it("answers as execFile does: output, bytes, and a non-zero exit's error fields", async () => {
    const env = { ...process.env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00+0000" };
    const ok = { args: ["rev-parse", "--git-dir"], cwd: dir, env };
    expect(await broker.runner.text(ok)).toEqual(await execFileGitRunner.text(ok));
    expect((await broker.runner.bytes(ok)).equals(await execFileGitRunner.bytes(ok))).toBe(true);
    const failing = { args: ["rev-parse", "--verify", "no-such-ref"], cwd: dir, env };
    expect(await rejection(broker.runner.text(failing))).toEqual(await rejection(execFileGitRunner.text(failing)));
    const brokerBytes = await rejection(broker.runner.bytes(failing));
    expect(Buffer.isBuffer(brokerBytes["stderr"])).toBe(true);
    expect(brokerBytes).toEqual(await rejection(execFileGitRunner.bytes(failing)));
  });

  it("fails a call after it is closed instead of hanging", async () => {
    const closed = new GitBroker();
    closed.close();
    await expect(closed.runner.text({ args: ["--version"], cwd: dir })).rejects.toThrow(/closed/);
  });
});

import { describe, expect, test } from "vitest";
import { initHostRepo, runHostGit, withGitRunner } from "./host-git.js";
import type { GitRunner } from "./host-git.js";

type Invocation = Parameters<GitRunner["text"]>[0];

function recordingRunner(calls: Invocation[]): GitRunner {
  return {
    text: async (invocation) => {
      calls.push(invocation);
      return { stdout: "recorded\n", stderr: "" };
    },
    bytes: async (invocation) => {
      calls.push(invocation);
      return Buffer.from("");
    },
  };
}

describe("the git runner port", () => {
  test("every host git call goes through the chosen runner, hardened and without GIT_* variables", async () => {
    const calls: Invocation[] = [];
    process.env["GIT_DIR"] = "/planted";
    try {
      await withGitRunner(recordingRunner(calls), async () => {
        const { stdout } = await runHostGit({ gitDir: "/repo/.git", workTree: "/repo" }, ["status"]);
        await initHostRepo("/target");
        expect(stdout).toBe("recorded\n");
      });
    } finally {
      delete process.env["GIT_DIR"];
    }

    const [hostCall, initCall] = calls;
    expect(hostCall?.args.slice(0, 2)).toEqual(["--git-dir=/repo/.git", "--work-tree=/repo"]);
    expect(hostCall?.args).toContain("core.hooksPath=/dev/null");
    expect(hostCall?.args.at(-1)).toBe("status");
    expect(hostCall?.cwd).toBe("/repo");
    expect(hostCall?.env?.["GIT_DIR"]).toBeUndefined();
    expect(initCall?.args.slice(-4)).toEqual(["-b", "main", "--", "/target"]);
  });

  // Two processes composed in one Node process (a crashed one and its restart) keep their own runners,
  // even with calls of both in flight at once.
  test("two scopes interleaved keep their own runners", async () => {
    const first: Invocation[] = [];
    const second: Invocation[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = withGitRunner(recordingRunner(first), async () => {
      await gate;
      await runHostGit({ gitDir: "/one/.git", workTree: "/one" }, ["status"]);
    });
    await withGitRunner(recordingRunner(second), () => runHostGit({ gitDir: "/two/.git", workTree: "/two" }, ["status"]));
    release();
    await slow;
    expect(first.map((call) => call.cwd)).toEqual(["/one"]);
    expect(second.map((call) => call.cwd)).toEqual(["/two"]);
  });
});

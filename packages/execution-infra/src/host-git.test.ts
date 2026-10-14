import { afterEach, describe, expect, test } from "vitest";
import { execFileGitRunner, initHostRepo, runHostGit, runOwnRepoGit, useGitRunner } from "./host-git.js";
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

afterEach(() => useGitRunner(execFileGitRunner));

describe("the git runner port", () => {
  test("every host git call goes through the chosen runner, hardened and without GIT_* variables", async () => {
    const calls: Invocation[] = [];
    useGitRunner(recordingRunner(calls));
    process.env["GIT_DIR"] = "/planted";
    try {
      const { stdout } = await runHostGit({ gitDir: "/repo/.git", workTree: "/repo" }, ["status"]);
      await initHostRepo("/target");
      expect(stdout).toBe("recorded\n");
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

  test("git on Ashara's own checkout inherits the process environment", async () => {
    const calls: Invocation[] = [];
    useGitRunner(recordingRunner(calls));
    await runOwnRepoGit("/ashara", ["rev-parse", "--show-toplevel"]);
    expect(calls).toEqual([{ args: ["rev-parse", "--show-toplevel"], cwd: "/ashara" }]);
  });
});

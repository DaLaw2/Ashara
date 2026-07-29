import { describe, expect, test } from "vitest";
import {
  translateHostPath,
  buildContainerName,
  buildContainerEnv,
  buildPodmanRunArgs,
  PathOutsideWorkDir,
  SANDBOX_IMAGE,
  SANDBOX_TAG,
  ASHARA_MOUNT_ENTRIES,
} from "./container-spawn.js";

describe("translateHostPath", () => {
  test("translates a path under workDir to /workspace", () => {
    expect(
      translateHostPath("/tmp/work/task-1/.ashara/brief.json", "/tmp/work/task-1"),
    ).toBe("/workspace/.ashara/brief.json");
  });

  test("translates workDir itself to /workspace", () => {
    expect(translateHostPath("/tmp/work/task-1", "/tmp/work/task-1")).toBe("/workspace");
  });

  test("throws PathOutsideWorkDir for a path outside workDir", () => {
    try {
      translateHostPath("/etc/passwd", "/tmp/work/task-1");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PathOutsideWorkDir);
      const err = e as PathOutsideWorkDir;
      expect(err.hostPath).toBe("/etc/passwd");
      expect(err.hostWorkDir).toBe("/tmp/work/task-1");
      expect(err.operation).toBe("translateHostPath");
    }
  });

  test("rejects a path that shares a prefix but is not under workDir", () => {
    // /tmp/work/task-10 starts with /tmp/work/task-1 but is a sibling
    expect(() =>
      translateHostPath("/tmp/work/task-10/file.txt", "/tmp/work/task-1"),
    ).toThrow(PathOutsideWorkDir);
  });
});

describe("buildContainerName", () => {
  test("produces a podman-safe name with monotonic suffix", () => {
    const a = buildContainerName("wi_abc-123");
    const b = buildContainerName("wi_abc-123");
    expect(a).toMatch(/^ashara-agent-wi_abc-123-\d+$/);
    expect(b).toMatch(/^ashara-agent-wi_abc-123-\d+$/);
    expect(a).not.toBe(b);
  });

  test("sanitizes chars invalid for podman names", () => {
    const name = buildContainerName("task/with:special@chars");
    expect(name).not.toMatch(/[/:@]/);
    expect(name).toContain("task_with_special_chars");
  });
});

describe("buildContainerEnv", () => {
  test("filters out host-only vars and translates paths", () => {
    const hostEnv: Record<string, string> = {
      HOME: "/home/user",
      PATH: "/usr/bin",
      NODE_ENV: "production",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      npm_config_cache: "/home/user/.npm",
    };
    const env = buildContainerEnv(hostEnv, "/tmp/work", {
      briefPath: "/tmp/work/.ashara/brief.json",
      outputPath: "/tmp/work/.ashara/output.json",
      workDir: "/tmp/work",
      catalogPath: "/tmp/work/.ashara/gateway-catalog.json",
      capability: "Standard",
    });

    expect(env["HOME"]).toBeUndefined();
    expect(env["PATH"]).toBeUndefined();
    expect(env["npm_config_cache"]).toBeUndefined();
    expect(env["NODE_ENV"]).toBe("production");
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-xxx");
    expect(env["ASHARA_BRIEF_PATH"]).toBe("/workspace/.ashara/brief.json");
    expect(env["ASHARA_OUTPUT_PATH"]).toBe("/workspace/.ashara/output.json");
    expect(env["ASHARA_WORKING_DIR"]).toBe("/workspace");
    expect(env["ASHARA_CATALOG_PATH"]).toBe("/workspace/.ashara/gateway-catalog.json");
    expect(env["AGENT_CAPABILITY"]).toBe("Standard");
  });
});

describe("buildPodmanRunArgs", () => {
  test("produces the expected argument structure", () => {
    const args = buildPodmanRunArgs(
      "ashara-agent-test-1",
      "/tmp/work",
      "/opt/ashara",
      { NODE_ENV: "production", API_KEY: "xxx" },
    );

    expect(args[0]).toBe("run");
    expect(args).toContain("--rm");
    expect(args).toContain("--userns=keep-id");
    expect(args).toContain(`${SANDBOX_IMAGE}:${SANDBOX_TAG}`);

    // Work dir mount: read-write with SELinux label
    const workMount = args[args.indexOf("-v") + 1];
    expect(workMount).toBe("/tmp/work:/workspace:z");

    // Ashara mounts: one per entry in the enumerated allowlist, all ro,z.
    // The old single root mount (/opt/ashara:/ashara:ro,z) must be absent —
    // it exposed .env to commands in the agent's allowlist.
    const vIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === "-v") acc.push(i);
      return acc;
    }, []);
    const mountArgs = vIndices.map((i) => args[i + 1]);
    // First mount is the workspace; remaining are the enumerated Ashara paths
    expect(mountArgs).toHaveLength(1 + ASHARA_MOUNT_ENTRIES.length);
    for (const entry of ASHARA_MOUNT_ENTRIES) {
      const expected = `/opt/ashara/${entry.hostRelative}:${entry.containerPath}:ro,z`;
      expect(mountArgs).toContainEqual(expected);
    }
    // The old root mount must not appear
    expect(mountArgs).not.toContainEqual("/opt/ashara:/ashara:ro,z");

    // Env vars passed through
    const eIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === "-e") acc.push(i);
      return acc;
    }, []);
    expect(eIndices).toHaveLength(2);

    // Command: node → tsx cli → runner
    const imgIdx = args.indexOf(`${SANDBOX_IMAGE}:${SANDBOX_TAG}`);
    expect(args[imgIdx + 1]).toBe("node");
    expect(args[imgIdx + 2]).toContain("tsx/dist/cli.mjs");
    expect(args[imgIdx + 3]).toContain("agent-runner/src/runner.ts");
  });
});

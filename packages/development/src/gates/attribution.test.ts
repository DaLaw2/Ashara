import { describe, test, expect, vi } from "vitest";

import { extractImplicatedFiles, attributeFilesToTasks } from "./attribution.js";
import type { WorkItemLookup, GitLogRunner } from "./attribution.js";

describe("extractImplicatedFiles", () => {
  test("extracts TypeScript diagnostic paths", () => {
    const output = [
      "src/routes/auth.ts(12,5): error TS2345: Argument of type ...",
      "src/middleware/cors.tsx(3,1): error TS1005: ';' expected.",
    ].join("\n");

    expect(extractImplicatedFiles(output)).toEqual([
      "src/routes/auth.ts",
      "src/middleware/cors.tsx",
    ]);
  });

  test("extracts route-reachability list paths", () => {
    const output = [
      "route-reachability check failed: 2 route file(s) not imported:",
      "  - src/routes/auth.ts",
      "  - src/routes/users.tsx",
    ].join("\n");

    expect(extractImplicatedFiles(output)).toEqual([
      "src/routes/auth.ts",
      "src/routes/users.tsx",
    ]);
  });

  test("extracts Node stack trace paths", () => {
    const output = [
      "Error: Cannot find module './missing'",
      "    at Object.<anonymous> (src/index.ts:5:1)",
      "    at Module._compile (node:internal/modules/cjs/loader:1369:14)",
      "    at startup (src/boot.mjs:12:3)",
    ].join("\n");

    const result = extractImplicatedFiles(output);
    expect(result).toContain("src/index.ts");
    expect(result).toContain("src/boot.mjs");
  });

  test("extracts generic src/ file references", () => {
    const output = "The file src/utils/helper.ts was modified and src/lib/db.js broke.";

    const result = extractImplicatedFiles(output);
    expect(result).toContain("src/utils/helper.ts");
    expect(result).toContain("src/lib/db.js");
  });

  test("deduplicates files appearing in multiple patterns", () => {
    const output = [
      "src/routes/auth.ts(12,5): error TS2345: ...",
      "    at handler (src/routes/auth.ts:12:5)",
      "Something about src/routes/auth.ts failed",
    ].join("\n");

    expect(extractImplicatedFiles(output)).toEqual(["src/routes/auth.ts"]);
  });

  test("returns empty array for output with no file paths", () => {
    expect(extractImplicatedFiles("all good, nothing to see")).toEqual([]);
    expect(extractImplicatedFiles("")).toEqual([]);
  });

  test("handles mixed output from multiple gate types", () => {
    const output = [
      "tsc --noEmit failed:",
      "src/routes/auth.ts(12,5): error TS2345: ...",
      "",
      "route-reachability check failed:",
      "  - src/routes/users.tsx",
      "",
      "    at boot (src/index.ts:1:1)",
    ].join("\n");

    const result = extractImplicatedFiles(output);
    expect(result).toContain("src/routes/auth.ts");
    expect(result).toContain("src/routes/users.tsx");
    expect(result).toContain("src/index.ts");
  });
});

describe("attributeFilesToTasks", () => {
  function makeRunner(
    responses: Record<string, string>,
  ): GitLogRunner {
    return async (args, _cwd) => {
      const file = args[args.length - 1];
      return { stdout: responses[file] ?? "" };
    };
  }

  function makeRepo(
    items: Record<string, { title: string; status: string }>,
  ): WorkItemLookup {
    return {
      findById: async (id) => {
        const item = items[id];
        return item ? { id, ...item } : null;
      },
    };
  }

  test("attributes a single file to a single completed culprit", async () => {
    const runner = makeRunner({
      "src/auth.ts": "abc123 merge: task task-001\ndef456 initial commit\n",
    });
    const repo = makeRepo({
      "task-001": { title: "Add auth middleware", status: "Completed" },
    });

    const results = await attributeFilesToTasks("/project", ["src/auth.ts"], repo, runner);

    expect(results).toEqual([
      {
        culpritTaskId: "task-001",
        culpritTitle: "Add auth middleware",
        implicatedFiles: ["src/auth.ts"],
        mergeCommitSha: "abc123",
      },
    ]);
  });

  test("groups multiple files under the same culprit", async () => {
    const runner = makeRunner({
      "src/auth.ts": "abc123 merge: task task-001\n",
      "src/middleware.ts": "abc123 merge: task task-001\n",
    });
    const repo = makeRepo({
      "task-001": { title: "Add auth", status: "Completed" },
    });

    const results = await attributeFilesToTasks(
      "/project",
      ["src/auth.ts", "src/middleware.ts"],
      repo,
      runner,
    );

    expect(results).toHaveLength(1);
    expect(results[0].implicatedFiles).toEqual(["src/auth.ts", "src/middleware.ts"]);
  });

  test("returns multiple culprits when files belong to different tasks", async () => {
    const runner = makeRunner({
      "src/auth.ts": "aaa111 merge: task task-001\n",
      "src/db.ts": "bbb222 merge: task task-002\n",
    });
    const repo = makeRepo({
      "task-001": { title: "Add auth", status: "Completed" },
      "task-002": { title: "Add database", status: "Completed" },
    });

    const results = await attributeFilesToTasks(
      "/project",
      ["src/auth.ts", "src/db.ts"],
      repo,
      runner,
    );

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.culpritTaskId);
    expect(ids).toContain("task-001");
    expect(ids).toContain("task-002");
  });

  test("returns empty when no merge commits found", async () => {
    const runner = makeRunner({
      "src/auth.ts": "abc123 initial commit\ndef456 fix typo\n",
    });
    const repo = makeRepo({});

    const results = await attributeFilesToTasks("/project", ["src/auth.ts"], repo, runner);
    expect(results).toEqual([]);
  });

  test("filters out non-Completed tasks", async () => {
    const runner = makeRunner({
      "src/auth.ts": "abc123 merge: task task-001\n",
    });
    const repo = makeRepo({
      "task-001": { title: "WIP task", status: "InProgress" },
    });

    const results = await attributeFilesToTasks("/project", ["src/auth.ts"], repo, runner);
    expect(results).toEqual([]);
  });

  test("filters out tasks not found in the repo", async () => {
    const runner = makeRunner({
      "src/auth.ts": "abc123 merge: task task-missing\n",
    });
    const repo = makeRepo({});

    const results = await attributeFilesToTasks("/project", ["src/auth.ts"], repo, runner);
    expect(results).toEqual([]);
  });

  test("handles git log failure gracefully", async () => {
    const runner: GitLogRunner = async () => {
      throw new Error("git not found");
    };
    const repo = makeRepo({});

    const results = await attributeFilesToTasks("/project", ["src/auth.ts"], repo, runner);
    expect(results).toEqual([]);
  });

  test("handles empty file list", async () => {
    const runner = vi.fn();
    const repo = makeRepo({});

    const results = await attributeFilesToTasks("/project", [], repo, runner);
    expect(results).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });
});

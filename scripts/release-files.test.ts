import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

// The public repository's own files: no gate reads the CI workflow, .gitignore or README.md, so
// these tests hold the claims each makes about the others.

const FORK_PR_EXPRESSION =
  "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}";

const stepSchema = z.object({
  name: z.string().optional(),
  uses: z.string().optional(),
  if: z.string().optional(),
  run: z.string().optional(),
});

const workflowSchema = z.object({
  permissions: z.record(z.string(), z.string()).optional(),
  jobs: z.object({
    "secret-scan": z.object({
      env: z.record(z.string(), z.string()).optional(),
      steps: z.array(stepSchema).min(1),
    }),
    test: z.object({ steps: z.array(stepSchema).min(1) }),
    "ci-result": z.object({ needs: z.array(z.string()) }),
  }),
});

const workflow = workflowSchema.parse(parse(fs.readFileSync(".github/workflows/ci.yml", "utf8")));

describe("ci.yml", () => {
  test("every job's token is read-only by default", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  test("the secret scan skips only a fork pull request and runs everything else", () => {
    const job = workflow.jobs["secret-scan"];
    expect(job.env?.["FORK_PR"]).toBe(FORK_PR_EXPRESSION);
    const [notice, ...scan] = job.steps;
    expect(notice?.if).toBe("env.FORK_PR == 'true'");
    expect(notice?.run).toContain("::notice::");
    expect(scan.map((step) => step.if)).toEqual(scan.map(() => "env.FORK_PR != 'true'"));
    const requireKey = scan.find((step) => step.name === "Require GITGUARDIAN_API_KEY");
    expect(requireKey?.run).toMatch(/exit 1/);
    expect(scan.some((step) => step.uses?.startsWith("GitGuardian/ggshield-action@") === true)).toBe(true);
  });

  test("the aggregate still requires the gate and every shard", () => {
    expect(workflow.jobs["ci-result"].needs).toEqual(["check", "test"]);
  });

  test("the podman step fails unless README.md names the runner's podman version", () => {
    const prepare = workflow.jobs.test.steps.find((step) => step.name === "Prepare podman and the pinned test images");
    expect(prepare?.run).toContain('grep -qF "podman ${podman_version}" README.md');
  });
});

describe("README.md", () => {
  test("names the podman versions the suite passes on and refuses none", () => {
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toContain("podman 4.9.3");
    expect(readme).not.toMatch(/podman 5\.x is required/i);
  });
});

describe(".gitignore", () => {
  test("keeps keys and database dumps out of the repository", () => {
    const paths = ["x.key", "x.pem", "x.p12", "id_ed25519", "x.dump", "x.sql.gz"];
    const ignored = execFileSync("git", ["check-ignore", "--no-index", ...paths], { encoding: "utf8" });
    expect(ignored.trim().split("\n")).toEqual(paths);
  });
});

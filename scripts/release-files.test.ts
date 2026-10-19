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

const anyJobSchema = z.object({
  "runs-on": z.string(),
  strategy: z.object({ matrix: z.record(z.string(), z.unknown()).optional() }).optional(),
  steps: z.array(stepSchema).min(1),
});

const allJobsSchema = z.object({ jobs: z.record(z.string(), anyJobSchema) });

const ciText = fs.readFileSync(".github/workflows/ci.yml", "utf8");
const workflow = workflowSchema.parse(parse(ciText));
const allJobs = Object.entries(allJobsSchema.parse(parse(ciText)).jobs);
// The version comment is read from the raw text: a YAML parse drops comments.
const usesLines = ciText.split("\n").filter((line) => /^\s*(?:-\s+)?uses:/.test(line));

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

  test("the podman step fails unless README.md names the runner's podman version", () => {
    const prepare = workflow.jobs.test.steps.find((step) => step.name === "Prepare podman and the pinned test images");
    expect(prepare?.run).toContain('grep -qF "podman ${podman_version}" README.md');
  });

  // A moving label such as ubuntu-latest lets GitHub change the runner, and the podman it tests on,
  // without a commit.
  test("every job names an explicit Ubuntu image", () => {
    expect(allJobs.filter(([, job]) => !/^ubuntu-\d+\.\d+$/.test(job["runs-on"])).map(([name]) => name)).toEqual([]);
  });

  test("the suite runs as one job, never sharded", () => {
    expect(allJobs.filter(([, job]) => job.strategy?.matrix?.["shard"] !== undefined).map(([name]) => name)).toEqual(
      [],
    );
    const sharded = allJobs.flatMap(([, job]) => job.steps).filter((step) => step.run?.includes("--shard") === true);
    expect(sharded).toEqual([]);
  });

  test("every action is pinned by full commit SHA with its version", () => {
    expect(usesLines.length).toBeGreaterThan(0);
    expect(usesLines.filter((line) => !/@[0-9a-f]{40} # v\S+$/.test(line))).toEqual([]);
    const parsedUses = allJobs.flatMap(([, job]) => job.steps).filter((step) => step.uses !== undefined);
    expect(parsedUses).toHaveLength(usesLines.length);
  });

  test("the required status needs the secret scan and the test suite", () => {
    expect(workflow.jobs["ci-result"].needs).toEqual(expect.arrayContaining(["secret-scan", "check", "test"]));
  });
});

describe("README.md", () => {
  test("names the podman versions the suite passes on and refuses none", () => {
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toContain("podman 4.9.3");
    expect(readme).not.toMatch(/podman 5\.x is required/i);
  });

  test("its setup creates the .env and the API token the server refuses to start without", () => {
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toContain("cp config/env.example .env");
    expect(readme).toContain("secret.ts put server/api_token");
    const required = [...fs.readFileSync("config/env.example", "utf8").matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);
    for (const variable of required) expect(readme).toContain(`\`${variable}\``);
  });
});

describe(".gitignore", () => {
  test("keeps keys and database dumps out of the repository", () => {
    const paths = ["x.key", "x.pem", "x.p12", "id_ed25519", "x.dump", "x.sql.gz"];
    const ignored = execFileSync("git", ["check-ignore", "--no-index", ...paths], { encoding: "utf8" });
    expect(ignored.trim().split("\n")).toEqual(paths);
  });
});

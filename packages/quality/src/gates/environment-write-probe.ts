import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ENVIRONMENT_DEFINITION_PATH,
  commitAllChanges,
  createWorkdir,
  ensureTargetGitInit,
  recipePaths,
  targetRepo,
  type Cell,
  type CellSpec,
  type ProbeVerdict,
} from "@ashara/execution-infra";
import { readEnvironmentDefinition } from "../environment-definition.js";
import { taskBranchName } from "../merge.js";
import { checkBranchOwnership } from "./ownership.js";

const PROBE_TASK_ID = "probe-environment-write";
const CONTAINERFILE = "environment/Containerfile";
const DEFINITION = [
  `containerfile = "${CONTAINERFILE}"`,
  "recipe = []",
  "inputs = []",
  'probe = "true"',
  'build = "true"',
  'test = "true"',
  "",
].join("\n");
const CONTAINERFILE_TEXT = "FROM scratch\n";

interface EnvironmentWriteProbeRequest {
  readonly substrate: { createCell(spec: CellSpec): Promise<Cell> };
  /** The image the cell starts from. */
  readonly image: string;
  readonly instance: string;
  /** An empty directory under the substrate's mount root: the probe's workdir base, holding its target and its worktree. */
  readonly workRoot: string;
}

/**
 * The environment-file write without the grant. A task that is not environment
 * work (the grant) changes the recipe from inside its cell, as an agent's tool call would; Z0
 * commits the tree to the task branch as after every attempt, and the ownership gate runs as
 * before every merge. The write itself lands in the cell's tree: the protection is that nothing of
 * it reaches main, and what keeps it from main is the gate, since every merge runs it first. The
 * probe runs no merge, so the gate's verdict is all it observes: held when the gate does not pass
 * the branch clean, breached when it does, unverifiable when the write did not land in the cell.
 */
export async function probeEnvironmentWrite(request: EnvironmentWriteProbeRequest): Promise<ProbeVerdict> {
  const probe = "environment-file write without the grant";
  const target = join(request.workRoot, "target");
  await mkdir(join(target, "environment"), { recursive: true });
  await writeFile(join(target, ENVIRONMENT_DEFINITION_PATH), DEFINITION);
  await writeFile(join(target, CONTAINERFILE), CONTAINERFILE_TEXT);
  await ensureTargetGitInit(target, request.workRoot);
  const repo = targetRepo(target);
  const recipe = recipePaths(await readEnvironmentDefinition(repo.gitDir, "main"));

  const branch = taskBranchName(PROBE_TASK_ID);
  const work = await createWorkdir(request.workRoot, target, branch);
  const cell = await request.substrate.createCell({
    image: request.image,
    project: "probe",
    task: PROBE_TASK_ID,
    role: "worker",
    instance: request.instance,
    mount: { hostPath: work.workDir },
  });
  let exitCode: number | null;
  try {
    exitCode = (await cell.exec(["sh", "-c", `printf 'RUN echo probe\\n' >> ${CONTAINERFILE}`], { timeoutSeconds: 30 })).exitCode;
  } finally {
    await cell.teardown();
  }
  const write = `the in-cell write exited ${exitCode ?? "none"}`;
  if (exitCode !== 0) {
    return { probe, outcome: "unverifiable", evidence: `${write}, so no recipe change reached the branch for the ownership gate to judge` };
  }

  await commitAllChanges(work.repo, `probe: task ${PROBE_TASK_ID} writes the recipe`);
  const verdict = await checkBranchOwnership(target, PROBE_TASK_ID, branch, recipe, []);
  return {
    probe,
    outcome: verdict.kind !== "clean" ? "held" : "breached",
    evidence:
      `${write}; the ownership gate returned ${verdict.kind}` +
      (verdict.kind === "clean" ? "" : ` (${verdict.reason})`) +
      "; the probe runs no merge, so this verdict is all it observed",
  };
}

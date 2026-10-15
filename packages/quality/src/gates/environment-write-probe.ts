import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ENVIRONMENT_DEFINITION_PATH,
  commitAllChanges,
  createWorkdir,
  ensureTargetGitInit,
  recipePaths,
  runHostGit,
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

export interface EnvironmentWriteProbeRequest {
  readonly substrate: { createCell(spec: CellSpec): Promise<Cell> };
  /** The image the cell starts from. */
  readonly image: string;
  readonly instance: string;
  /** An empty directory under the substrate's mount root: the probe's workdir base, holding its target and its worktree. */
  readonly workRoot: string;
}

/**
 * Roadmap M2 exit 6, the environment-file write without the grant. A task that is not environment
 * work (the grant) changes the recipe from inside its cell, as an agent's tool call would; Z0
 * commits the tree to the task branch as after every attempt, and the ownership gate runs as
 * before every merge. The write itself lands in the cell's tree: the protection is that nothing of
 * it reaches main. Held when the gate does not pass the branch clean and main's recipe is unchanged.
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
  let write: string;
  try {
    const result = await cell.exec(["sh", "-c", `printf 'RUN echo probe\\n' >> ${CONTAINERFILE}`], { timeoutSeconds: 30 });
    write = `the in-cell write exited ${result.exitCode ?? "none"}`;
  } finally {
    await cell.teardown();
  }

  await commitAllChanges(work.repo, `probe: task ${PROBE_TASK_ID} writes the recipe`);
  const verdict = await checkBranchOwnership(target, PROBE_TASK_ID, branch, recipe, []);
  const { stdout: mainContainerfile } = await runHostGit(repo, ["show", `refs/heads/main:${CONTAINERFILE}`]);
  const mainUnchanged = mainContainerfile === CONTAINERFILE_TEXT;
  return {
    probe,
    outcome: verdict.kind !== "clean" && mainUnchanged ? "held" : "breached",
    evidence:
      `${write}; the ownership gate returned ${verdict.kind}` +
      (verdict.kind === "clean" ? "" : ` (${verdict.reason})`) +
      `; main's ${CONTAINERFILE} ${mainUnchanged ? "is unchanged" : `changed to ${JSON.stringify(mainContainerfile)}`}`,
  };
}

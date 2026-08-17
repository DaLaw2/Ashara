import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const COMPILER_DIAGNOSTIC = /^(.+)\(\d+,\d+\):/;
const ROUTE_REACHABILITY = /^\s*-\s+(.+\.\w+)$/;
const STACK_TRACE = /at .+ \((.+\.\w+):\d+:\d+\)/g;
const GENERIC_FILE_REF = /(?:^|\s)(src\/[^\s:]+\.\w+)/gm;

export function extractImplicatedFiles(gateOutput: string): string[] {
  const files = new Set<string>();

  for (const line of gateOutput.split("\n")) {
    const tscMatch = COMPILER_DIAGNOSTIC.exec(line);
    if (tscMatch) {
      files.add(tscMatch[1]);
      continue;
    }

    const routeMatch = ROUTE_REACHABILITY.exec(line);
    if (routeMatch) {
      files.add(routeMatch[1]);
      continue;
    }
  }

  let match: RegExpExecArray | null;

  STACK_TRACE.lastIndex = 0;
  while ((match = STACK_TRACE.exec(gateOutput)) !== null) {
    files.add(match[1]);
  }

  GENERIC_FILE_REF.lastIndex = 0;
  while ((match = GENERIC_FILE_REF.exec(gateOutput)) !== null) {
    files.add(match[1]);
  }

  return [...files];
}

export interface AttributionResult {
  readonly culpritTaskId: string;
  readonly culpritTitle: string;
  readonly implicatedFiles: string[];
  readonly mergeCommitSha: string;
}

export interface WorkItemLookup {
  findById(id: string): Promise<{ id: string; title: string; status: string } | null>;
}

export type GitLogRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<{ stdout: string }>;

const MERGE_COMMIT_PATTERN = /^([0-9a-f]+) merge: task (.+)$/;

async function gitLog(
  targetProjectPath: string,
  file: string,
  runner: GitLogRunner,
): Promise<Array<{ sha: string; taskId: string }>> {
  const { stdout } = await runner(
    ["log", "--all", "--format=%H %s", "--", file],
    targetProjectPath,
  );
  const results: Array<{ sha: string; taskId: string }> = [];
  for (const line of stdout.split("\n")) {
    const match = MERGE_COMMIT_PATTERN.exec(line.trim());
    if (match) {
      results.push({ sha: match[1], taskId: match[2] });
    }
  }
  return results;
}

const defaultGitLogRunner: GitLogRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return { stdout };
};

export async function attributeFilesToTasks(
  targetProjectPath: string,
  files: string[],
  workItemRepo: WorkItemLookup,
  runner: GitLogRunner = defaultGitLogRunner,
): Promise<AttributionResult[]> {
  const taskMap = new Map<
    string,
    { title: string; files: string[]; sha: string }
  >();

  for (const file of files) {
    let commits: Array<{ sha: string; taskId: string }>;
    try {
      commits = await gitLog(targetProjectPath, file, runner);
    } catch {
      continue;
    }
    if (commits.length === 0) continue;

    const latest = commits[0];
    const item = await workItemRepo.findById(latest.taskId);
    if (!item || item.status !== "Completed") continue;

    const existing = taskMap.get(latest.taskId);
    if (existing) {
      existing.files.push(file);
    } else {
      taskMap.set(latest.taskId, {
        title: item.title,
        files: [file],
        sha: latest.sha,
      });
    }
  }

  return [...taskMap.entries()].map(([taskId, entry]) => ({
    culpritTaskId: taskId,
    culpritTitle: entry.title,
    implicatedFiles: entry.files,
    mergeCommitSha: entry.sha,
  }));
}

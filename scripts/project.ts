/**
 * Operator access to a project's status (story s-loop-never-stop-m1, migration 040).
 *
 *   npx tsx scripts/project.ts unblock <project-id> --reason <text> [--by <name>]
 *
 * Returns a blocked project to work after its cause is cleared (the budget raised, the
 * configuration corrected, the bad record repaired): its open block episode is ended with who
 * and why, the project becomes 'active', and the Liaison tells the client once, on its next
 * cycle, that work resumed. A project whose first planning gave up has its planning record reset,
 * so planning runs again. `--by` defaults to the operating-system user running the command.
 * Read the cause first: SELECT blocked_category, blocked_error_class, blocked_reason FROM projects.
 */

import { userInfo } from "node:os";
import { createDb, DEFAULT_DATABASE_URL } from "@ashara/db";
import { ProjectHaltRepository } from "@ashara/delivery";
import { describeErrorChain, parseProjectId, type ProjectId } from "@ashara/shared";

class ProjectCliUsageError extends Error {
  constructor(detail: string) {
    super(`${detail}\nUsage: npx tsx scripts/project.ts unblock <project-id> --reason <text> [--by <name>]`);
    this.name = "ProjectCliUsageError";
  }
}

interface UnblockArgs {
  readonly projectId: ProjectId;
  readonly reason: string;
  readonly by: string;
}

function parseUnblockArgs(args: readonly string[]): UnblockArgs {
  const [projectId, ...rest] = args;
  if (projectId === undefined || projectId.startsWith("--")) throw new ProjectCliUsageError("unblock needs a project id.");
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if ((flag !== "--reason" && flag !== "--by") || value === undefined || value.trim() === "") {
      throw new ProjectCliUsageError(`Unexpected or empty argument: ${flag ?? ""}.`);
    }
    if (flags.has(flag)) throw new ProjectCliUsageError(`${flag} given twice.`);
    flags.set(flag, value.trim());
  }
  const reason = flags.get("--reason");
  if (reason === undefined) throw new ProjectCliUsageError("unblock needs --reason: why the cause is cleared.");
  return { projectId: parseProjectId(projectId, "unblock <project-id> argument"), reason, by: flags.get("--by") ?? userInfo().username };
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "unblock") throw new ProjectCliUsageError(`Unknown command: ${command ?? "(none)"}.`);
  const { projectId, reason, by } = parseUnblockArgs(args);

  const db = createDb(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
  try {
    const { episodeId } = await new ProjectHaltRepository(db).unblock(projectId, by, reason);
    console.log(`project ${projectId}: unblocked by ${by} (block episode ${episodeId}); the client is told on the next cycle`);
  } finally {
    await db.$client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${describeErrorChain(err)}\n`);
  process.exit(1);
});

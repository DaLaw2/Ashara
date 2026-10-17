/**
 * Operator access to a project's status (story s-loop-never-stop-m1) and its work
 * budget (ADR-084 decision 1).
 *
 *   npx tsx scripts/project.ts unblock <project-id> --reason <text> [--by <name>]
 *   npx tsx scripts/project.ts grant <project-id> --requests <n> --reason <text> [--by <name>]
 *
 * `unblock` returns a blocked project to work after its cause is cleared (the budget raised, the
 * configuration corrected, the bad record repaired): its open block episode is ended with who
 * and why, the project becomes 'active', and the Liaison tells the client once, on its next
 * cycle, that work resumed. A project whose first planning gave up has its planning record reset,
 * so planning runs again.
 *
 * `grant` records the owner's grant of <n> more model requests to the project's work budget: the
 * only way the budget grows, since its spent requests are its llm_calls rows and nothing returns
 * one. A project halted on its spent work budget (block kind work_budget) still needs `unblock`
 * after the grant. `--by` defaults to the operating-system user running the command.
 * Read the cause first: SELECT blocked_category, blocked_error_class, blocked_reason FROM projects.
 */

import { userInfo } from "node:os";
import { createDb, DEFAULT_DATABASE_URL, WorkGrantRepository } from "@ashara/db";
import { ProjectHaltRepository } from "@ashara/delivery";
import { describeErrorChain, parseProjectId, type ProjectId } from "@ashara/shared";

const USAGE =
  "Usage: npx tsx scripts/project.ts unblock <project-id> --reason <text> [--by <name>]\n" +
  "       npx tsx scripts/project.ts grant <project-id> --requests <n> --reason <text> [--by <name>]";

class ProjectCliUsageError extends Error {
  constructor(detail: string) {
    super(`${detail}\n${USAGE}`);
    this.name = "ProjectCliUsageError";
  }
}

interface ParsedArgs {
  readonly projectId: ProjectId;
  readonly flags: ReadonlyMap<string, string>;
  readonly by: string;
}

function parseArgs(command: string, args: readonly string[], allowed: readonly string[]): ParsedArgs {
  const [projectId, ...rest] = args;
  if (projectId === undefined || projectId.startsWith("--")) throw new ProjectCliUsageError(`${command} needs a project id.`);
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === undefined || !allowed.includes(flag) || value === undefined || value.trim() === "") {
      // eslint-disable-next-line no-restricted-syntax -- policy default: message text only
      throw new ProjectCliUsageError(`Unexpected or empty argument: ${flag ?? ""}.`);
    }
    if (flags.has(flag)) throw new ProjectCliUsageError(`${flag} given twice.`);
    flags.set(flag, value.trim());
  }
  if (!flags.has("--reason")) throw new ProjectCliUsageError(`${command} needs --reason: why.`);
  return {
    projectId: parseProjectId(projectId, `${command} <project-id> argument`),
    flags,
    by: flags.get("--by") ?? userInfo().username,
  };
}

function requiredFlag(flags: ReadonlyMap<string, string>, flag: string, command: string): string {
  const value = flags.get(flag);
  if (value === undefined) throw new ProjectCliUsageError(`${command} needs ${flag}.`);
  return value;
}

function parseRequests(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new ProjectCliUsageError(`--requests must be a positive whole number of model requests, got "${raw}".`);
  const requests = Number(raw);
  if (!Number.isSafeInteger(requests) || requests <= 0) throw new ProjectCliUsageError(`--requests must be a positive whole number of model requests, got "${raw}".`);
  return requests;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "unblock" && command !== "grant") throw new ProjectCliUsageError(`Unknown command: ${command ?? "(none)"}.`);
  const parsed =
    command === "unblock" ? parseArgs(command, args, ["--reason", "--by"]) : parseArgs(command, args, ["--requests", "--reason", "--by"]);
  const reason = requiredFlag(parsed.flags, "--reason", command);
  const requests = command === "grant" ? parseRequests(requiredFlag(parsed.flags, "--requests", command)) : null;
  const { projectId, by } = parsed;

  const db = createDb(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
  try {
    if (requests === null) {
      const { episodeId } = await new ProjectHaltRepository(db).unblock(projectId, by, reason);
      console.log(`project ${projectId}: unblocked by ${by} (block episode ${episodeId}); the client is told on the next cycle`);
      return;
    }
    const { grantId, grantedRequests } = await new WorkGrantRepository(db).grant({ projectId, requests, grantedBy: by, reason });
    console.log(
      `project ${projectId}: ${requests} model request(s) granted by ${by} (grant ${grantId}); ${grantedRequests} granted in all. ` +
        `A project halted on its work budget still needs: npx tsx scripts/project.ts unblock ${projectId} --reason <why>`,
    );
  } finally {
    await db.$client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${describeErrorChain(err)}\n`);
  process.exit(1);
});

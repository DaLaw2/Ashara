/**
 * Picks the tender a real run posts and appends the pick to the pool's ledger (scripts/pool-selection.ts states the
 * rule). An operator tool: nothing in Ashara's runtime calls it, and the pool's location is an argument or the
 * ASHARA_TENDER_POOL environment variable only.
 *
 *   npx tsx scripts/pool-select.ts --run <label> --commit <sha> [--pool <dir>] [--pin <tender id> --reason <text>]
 *
 * Prints the pick (tender, seed, reason) and the path of the tender's vision text; exits 1 with no pick when the
 * pool or the ledger cannot be used, or the run label already has a pick.
 */

import { join } from "node:path";
import { describeErrorChain } from "@ashara/shared";
import { appendPick, pickTender, poolDirOf, readLedger, readPool } from "@ashara/evaluation";

const USAGE = "Usage: npx tsx scripts/pool-select.ts --run <label> --commit <sha> [--pool <dir>] [--pin <tender id> --reason <text>]";

const FLAGS = ["--run", "--commit", "--pool", "--pin", "--reason"];

class PoolSelectUsageError extends Error {
  constructor(detail: string) {
    super(`${detail}\n${USAGE}`);
    this.name = "PoolSelectUsageError";
  }
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !FLAGS.includes(flag)) throw new PoolSelectUsageError(`Unknown argument ${JSON.stringify(flag)}.`);
    if (value === undefined || value === "") throw new PoolSelectUsageError(`${flag} needs a value.`);
    if (flags.has(flag)) throw new PoolSelectUsageError(`${flag} is given twice.`);
    flags.set(flag, value);
  }
  if (flags.has("--pin") !== flags.has("--reason")) throw new PoolSelectUsageError("--pin and --reason go together.");
  return flags;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const run = flags.get("--run");
  const commit = flags.get("--commit");
  if (run === undefined || commit === undefined) throw new PoolSelectUsageError("--run and --commit are required.");
  const poolDir = poolDirOf(flags.get("--pool"), process.env);
  const pool = await readPool(poolDir);
  const ledger = await readLedger(poolDir);
  const tender = flags.get("--pin");
  const reason = flags.get("--reason");
  const pin = tender === undefined || reason === undefined ? {} : { pin: { tender, reason } };
  const pick = pickTender(pool, ledger, { run, commit, at: new Date().toISOString(), ...pin });
  await appendPick(poolDir, pick);
  const picked = pool.find((entry) => entry.id === pick.tender);
  console.log(`pool-select: run ${pick.run} commit ${pick.commit} tender ${pick.tender} seed ${pick.seed} (${pick.reason})`);
  if (picked !== undefined) console.log(`vision text: ${join(poolDir, picked.dir, "vision.txt")}`);
}

main().catch((err: unknown) => {
  console.error(`\n${describeErrorChain(err)}\n`);
  process.exit(1);
});

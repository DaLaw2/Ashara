/**
 * The trust ledger's append command; @ashara/evaluation's trust-ledger module states its rules and exit status.
 *
 *   npx tsx scripts/trust-ledger.ts append <project-id> --run <label> --facts <facts.json> --mapping-a <reader-a.toml>
 *     --mapping-b <reader-b.toml> --key <key.json> [--hidden <verdict.json>] [--pool <dir>] [--ledger <ledger.jsonl>]
 */

import { trustLedgerMain } from "@ashara/evaluation";
import { describeErrorChain } from "@ashara/shared";

trustLedgerMain(process.argv.slice(2)).then(
  (status) => {
    process.exitCode = status;
  },
  (err: unknown) => {
    console.error(describeErrorChain(err));
    process.exitCode = 1;
  },
);

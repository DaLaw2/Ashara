/**
 * The trust record's command; @ashara/evaluation's trust-record module states its rules and exit status.
 *
 *   npx tsx scripts/trust-record.ts --ledger <ledger.jsonl> --out <record.md> [--stage <id>] [--repo <checkout>]
 */

import { trustRecordMain } from "@ashara/evaluation";
import { describeErrorChain } from "@ashara/shared";

trustRecordMain(process.argv.slice(2)).then(
  (status) => {
    process.exitCode = status;
  },
  (err: unknown) => {
    console.error(describeErrorChain(err));
    process.exitCode = 1;
  },
);

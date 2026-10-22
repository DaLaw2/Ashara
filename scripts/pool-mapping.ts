/**
 * The blind mapping's export and check commands; @ashara/evaluation's pool-mapping module states their rules and exit
 * status.
 *
 *   npx tsx scripts/pool-mapping.ts export --source <source.json> --seed <hex64> --packet <packet.json> --key <key.json>
 *   npx tsx scripts/pool-mapping.ts check --packet <packet.json> --mapping <reader.toml>
 */

import { poolMappingMain } from "@ashara/evaluation";
import { describeErrorChain } from "@ashara/shared";

poolMappingMain(process.argv.slice(2)).then(
  (status) => {
    process.exitCode = status;
  },
  (err: unknown) => {
    console.error(describeErrorChain(err));
    process.exitCode = 1;
  },
);

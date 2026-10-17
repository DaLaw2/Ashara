/**
 * Create the secret store's master key file (the key lives outside
 * the database). Writes 32 random bytes, base64, mode 0600, to
 * $ASHARA_SECRET_KEY_FILE or ~/.config/ashara/secret.key. Refuses to overwrite an
 * existing file: secrets encrypted under it would become undecryptable.
 *
 * Prints the path and the key id only — never the key.
 *
 * Usage: npx tsx scripts/secret-key-init.ts
 */

import { createKeyFile, resolveKeyFilePath } from "@ashara/security";
import { describeErrorChain } from "@ashara/shared";

function main(): void {
  const keyFilePath = resolveKeyFilePath(process.env);
  const { keyId } = createKeyFile(keyFilePath);
  console.log(`Wrote secret key file ${keyFilePath} (key id ${keyId}, mode 0600).`);
}

try {
  main();
} catch (err: unknown) {
  // eslint-disable-next-line ashara/catch-continue -- best effort: the operator script exits 1 below with the error's chain
  console.error(`\n${describeErrorChain(err)}\n`);
  process.exit(1);
}

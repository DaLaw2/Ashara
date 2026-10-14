/**
 * Create the secret store's master key file (ADR-073 Q10: the key lives outside
 * the database). Writes 32 random bytes, base64, mode 0600, to
 * $ASHARA_SECRET_KEY_FILE or ~/.config/ashara/secret.key. Refuses to overwrite an
 * existing file: secrets encrypted under it would become undecryptable.
 *
 * Prints the path and the key id only — never the key.
 *
 * Usage: npx tsx scripts/secret-key-init.ts
 */

import fs from "node:fs";
import path from "node:path";
import { SecretKeyFileExists, generateKeyFileContent, resolveKeyFilePath } from "@ashara/security";
import { describeErrorChain } from "@ashara/shared";

function main(): void {
  const keyFilePath = resolveKeyFilePath(process.env);
  fs.mkdirSync(path.dirname(keyFilePath), { recursive: true, mode: 0o700 });

  const { content, keyId } = generateKeyFileContent();
  let fd: number;
  try {
    // "wx" makes existence check and creation one atomic step.
    fd = fs.openSync(keyFilePath, "wx", 0o600);
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST") {
      throw new SecretKeyFileExists(keyFilePath);
    }
    throw err;
  }
  try {
    // The umask can only narrow the mode; set it explicitly anyway so the result is exact.
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  console.log(`Wrote secret key file ${keyFilePath} (key id ${keyId}, mode 0600).`);
}

try {
  main();
} catch (err: unknown) {
  console.error(`\n${describeErrorChain(err)}\n`);
  process.exit(1);
}

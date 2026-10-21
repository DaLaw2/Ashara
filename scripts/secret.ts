/**
 * Operator access to the secret store. Never prints a secret value.
 *
 *   npx tsx scripts/secret.ts put <name>     value read from piped stdin, one trailing newline stripped;
 *                                            refuses a client access code (scripts/client.ts set-code)
 *   npx tsx scripts/secret.ts check <name>   confirms the secret exists and decrypts under the loaded key
 *   npx tsx scripts/secret.ts list           names only
 *
 * The value comes from stdin, never argv, so it does not land in shell history or `ps`.
 * Key file: $ASHARA_SECRET_KEY_FILE or ~/.config/ashara/secret.key (scripts/secret-key-init.ts).
 */

import { createDb, DEFAULT_DATABASE_URL } from "@ashara/db";
import { SecretRepository } from "@ashara/security";
import {
  SecretNotFound,
  SecretStore,
  isClientAccessCodeSecretName,
  loadMasterKey,
  resolveKeyFilePath,
} from "@ashara/security";
import { describeErrorChain } from "@ashara/shared";
import { readPipedStdin } from "./read-piped-stdin.js";

class SecretCliUsageError extends Error {
  constructor(detail: string) {
    super(
      `${detail}\nUsage: npx tsx scripts/secret.ts put <name> | check <name> | list\n` +
        `  put reads the value from piped stdin, e.g. \`read -rs V && printf '%s' "$V" | npx tsx scripts/secret.ts put provider/deepseek/api_key\``,
    );
    this.name = "SecretCliUsageError";
  }
}


function requireName(name: string | undefined, command: string): string {
  if (name === undefined) {
    throw new SecretCliUsageError(`${command} needs a secret name.`);
  }
  return name;
}

async function main(): Promise<void> {
  const [command, name, ...extra] = process.argv.slice(2);
  if (extra.length > 0) {
    throw new SecretCliUsageError(`Unexpected arguments: ${extra.length} extra.`);
  }

  const key = loadMasterKey(resolveKeyFilePath(process.env));
  const db = createDb(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
  const store = new SecretStore(new SecretRepository(db), key);
  try {
    switch (command) {
      case "put": {
        const secretName = requireName(name, command);
        if (isClientAccessCodeSecretName(secretName)) {
          // A code changed here would leave the client's old sessions valid.
          throw new SecretCliUsageError(
            `"${secretName}" is a client access code; set it with ` +
              "`npx tsx scripts/client.ts set-code <name>`, which also deletes the client's sessions. Nothing was stored.",
          );
        }
        await store.put(secretName, await readPipedStdin("secret.ts put"));
        console.log(`Stored secret "${secretName}" under key ${key.id}.`);
        return;
      }
      case "check": {
        const secretName = requireName(name, command);
        // An absent secret surfaces as SecretNotFound from get(), not as a usage error.
        await store.get(secretName);
        console.log(`Secret "${secretName}" decrypts under key ${key.id}.`);
        return;
      }
      case "list": {
        const names = await store.listNames();
        console.log(names.length > 0 ? names.join("\n") : "(no secrets stored)");
        return;
      }
      default:
        throw new SecretCliUsageError(`Unknown command: ${command ?? "(none)"}.`);
    }
  } finally {
    await db.$client.end();
  }
}

// Exit 2 distinguishes "absent" from every other failure for scripted `check` callers.
main().catch((err: unknown) => {
  console.error(`\n${describeErrorChain(err)}\n`);
  process.exit(err instanceof SecretNotFound ? 2 : 1);
});

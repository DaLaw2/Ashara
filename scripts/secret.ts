/**
 * Operator access to the secret store (ADR-073 Q10). Never prints a secret value.
 *
 *   npx tsx scripts/secret.ts put <name>     value read from piped stdin, one trailing newline stripped
 *   npx tsx scripts/secret.ts check <name>   confirms the secret exists and decrypts under the loaded key
 *   npx tsx scripts/secret.ts list           names only
 *   npx tsx scripts/secret.ts import-legacy  moves plaintext provider_configs.api_key and the
 *                                            system_settings 'api_token' row into the store, in
 *                                            one transaction; prints names and counts only
 *
 * The value comes from stdin, never argv, so it does not land in shell history or `ps`.
 * Key file: $ASHARA_SECRET_KEY_FILE or ~/.config/ashara/secret.key (scripts/secret-key-init.ts).
 */

import { createDb, DEFAULT_DATABASE_URL, SecretRepository } from "@ashara/db";
import { SecretNotFound, SecretStore, loadMasterKey, resolveKeyFilePath } from "@ashara/security";
import { importLegacyCredentials } from "./import-legacy-credentials.js";
import { readPipedStdin } from "./read-piped-stdin.js";

class SecretCliUsageError extends Error {
  constructor(detail: string) {
    super(
      `${detail}\nUsage: npx tsx scripts/secret.ts put <name> | check <name> | list | import-legacy\n` +
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
      case "import-legacy": {
        if (name !== undefined) {
          throw new SecretCliUsageError("import-legacy takes no arguments.");
        }
        const report = await db.transaction((tx) => importLegacyCredentials(tx, key));
        if (report.imported.length === 0) {
          console.log("Nothing to import: no plaintext provider api_key and no system_settings 'api_token' row.");
        } else {
          console.log(`Imported ${report.imported.length} secret(s) under key ${key.id}; plaintext removed:`);
          console.log(report.imported.map((n) => `  ${n}`).join("\n"));
        }
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
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof SecretNotFound ? 2 : 1);
});

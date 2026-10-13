/**
 * Operator access to the secret store (ADR-073 Q10). Never prints a secret value.
 *
 *   npx tsx scripts/secret.ts put <name>     value read from piped stdin, one trailing newline stripped
 *   npx tsx scripts/secret.ts check <name>   confirms the secret exists and decrypts under the loaded key
 *   npx tsx scripts/secret.ts list           names only
 *
 * The value comes from stdin, never argv, so it does not land in shell history or `ps`.
 * Key file: $ASHARA_SECRET_KEY_FILE or ~/.config/ashara/secret.key (scripts/secret-key-init.ts).
 */

import { createDb, DEFAULT_DATABASE_URL, SecretRepository } from "@ashara/db";
import { SecretStore, loadMasterKey, resolveKeyFilePath } from "@ashara/security";

class SecretCliUsageError extends Error {
  constructor(detail: string) {
    super(
      `${detail}\nUsage: npx tsx scripts/secret.ts put <name> | check <name> | list\n` +
        `  put reads the value from piped stdin, e.g. \`read -rs V && printf '%s' "$V" | npx tsx scripts/secret.ts put provider/deepseek/api_key\``,
    );
    this.name = "SecretCliUsageError";
  }
}

async function readPipedStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new SecretCliUsageError("put refuses to read the value from a terminal, where it would echo.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8").replace(/\r?\n$/, "");
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
        await store.put(secretName, await readPipedStdin());
        console.log(`Stored secret "${secretName}" under key ${key.id}.`);
        return;
      }
      case "check": {
        const secretName = requireName(name, command);
        if (!(await store.has(secretName))) {
          throw new SecretCliUsageError(`Secret "${secretName}" is not in the store.`);
        }
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

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

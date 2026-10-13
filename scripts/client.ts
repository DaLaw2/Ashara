/**
 * Operator access to the firm's clients (migration 018). Never prints an access code.
 *
 *   npx tsx scripts/client.ts add <name>   creates the client and stores its web-client
 *                                          access code, read from piped stdin, as the
 *                                          secret client/<clientId>/access_code; one
 *                                          transaction, so neither exists without the other
 *   npx tsx scripts/client.ts list         names and ids only
 *
 * e.g. `read -rs C && printf '%s' "$C" | npx tsx scripts/client.ts add "Acme Bakery"`
 * Key file: $ASHARA_SECRET_KEY_FILE or ~/.config/ashara/secret.key (scripts/secret-key-init.ts).
 */

import { ClientRepository, createDb, DEFAULT_DATABASE_URL, SecretRepository } from "@ashara/db";
import {
  MIN_CLIENT_ACCESS_CODE_LENGTH,
  SecretStore,
  clientAccessCodeSecretName,
  loadMasterKey,
  resolveKeyFilePath,
} from "@ashara/security";
import { readPipedStdin } from "./read-piped-stdin.js";

class ClientCliUsageError extends Error {
  constructor(detail: string) {
    super(
      `${detail}\nUsage: npx tsx scripts/client.ts add <name> | list\n` +
        `  add reads the access code from piped stdin, e.g. ` +
        `\`read -rs C && printf '%s' "$C" | npx tsx scripts/client.ts add "Acme Bakery"\``,
    );
    this.name = "ClientCliUsageError";
  }
}

/** The access code offered to `add` is too short to guard a login. Carries the length only. */
class AccessCodeTooShort extends Error {
  constructor(readonly length: number) {
    super(
      `refusing an access code of ${length} characters: at least ${MIN_CLIENT_ACCESS_CODE_LENGTH} are required ` +
        "(e.g. `openssl rand -base64 24`). Nothing was created.",
    );
    this.name = "AccessCodeTooShort";
  }
}

/** The name a client logs in with: trimmed, 1-200 characters (the login accepts at most 200). */
function parseClientName(raw: string | undefined): string | null {
  const name = raw?.trim();
  return name !== undefined && name.length >= 1 && name.length <= 200 ? name : null;
}

async function main(): Promise<void> {
  const [command, name, ...extra] = process.argv.slice(2);
  if (extra.length > 0) {
    throw new ClientCliUsageError(`Unexpected arguments: ${extra.length} extra (quote a name with spaces).`);
  }

  const db = createDb(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
  try {
    switch (command) {
      case "add": {
        const clientName = parseClientName(name);
        if (clientName === null) {
          throw new ClientCliUsageError("add needs a client name of 1-200 characters.");
        }
        // The key loads before stdin is read, so a missing key fails before the code is typed.
        const key = loadMasterKey(resolveKeyFilePath(process.env));
        const code = await readPipedStdin("client.ts add");
        if (code.length < MIN_CLIENT_ACCESS_CODE_LENGTH) throw new AccessCodeTooShort(code.length);
        const client = await db.transaction(async (tx) => {
          const created = await new ClientRepository(tx).create(clientName);
          await new SecretStore(new SecretRepository(tx), key).put(clientAccessCodeSecretName(created.id), code);
          return created;
        });
        console.log(
          `Created client "${client.name}" (${client.id}); its access code is stored as ` +
            `"${clientAccessCodeSecretName(client.id)}" under key ${key.id}.`,
        );
        return;
      }
      case "list": {
        if (name !== undefined) throw new ClientCliUsageError("list takes no arguments.");
        const clients = await new ClientRepository(db).list();
        console.log(clients.length > 0 ? clients.map((c) => `${c.id}  ${c.name}`).join("\n") : "(no clients)");
        return;
      }
      default:
        throw new ClientCliUsageError(`Unknown command: ${command ?? "(none)"}.`);
    }
  } finally {
    await db.$client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

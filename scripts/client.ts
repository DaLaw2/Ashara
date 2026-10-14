/**
 * Operator access to the firm's clients (migration 018). Never prints an access code.
 *
 *   npx tsx scripts/client.ts add <name>              creates the client and stores its web-client
 *                                                     access code, read from piped stdin, as the
 *                                                     secret client/<clientId>/access_code; one
 *                                                     transaction, so neither exists without the other
 *   npx tsx scripts/client.ts set-code <name>         replaces (or first stores) the client's access
 *                                                     code from piped stdin and deletes every session
 *                                                     of that client, in one transaction
 *   npx tsx scripts/client.ts remove-code <name>      deletes the client's access code and every
 *                                                     session of that client, in one transaction
 *   npx tsx scripts/client.ts revoke-sessions <name>  deletes every session of that client
 *   npx tsx scripts/client.ts list                    names and ids only
 *
 * e.g. `read -rs C && printf '%s' "$C" | npx tsx scripts/client.ts add "Acme Bakery"`
 * Key file: $ASHARA_SECRET_KEY_FILE or ~/.config/ashara/secret.key (scripts/secret-key-init.ts).
 *
 * An access code is set or removed only here, never through scripts/secret.ts: a
 * code changed without its sessions deleted would leave every session opened with
 * the old code valid until it expires.
 */

import {
  ClientRepository,
  ClientSessionRepository,
  createDb,
  DEFAULT_DATABASE_URL,
  SecretRepository,
} from "@ashara/db";
import {
  MIN_CLIENT_ACCESS_CODE_LENGTH,
  SecretStore,
  clientAccessCodeSecretName,
  loadMasterKey,
  resolveKeyFilePath,
} from "@ashara/security";
import type { MasterKey } from "@ashara/security";
import { describeErrorChain } from "@ashara/shared";
import { readPipedStdin } from "./read-piped-stdin.js";

const USAGE =
  "Usage: npx tsx scripts/client.ts add <name> | set-code <name> | remove-code <name> | revoke-sessions <name> | list\n" +
  "  add and set-code read the access code from piped stdin, e.g. " +
  "`read -rs C && printf '%s' \"$C\" | npx tsx scripts/client.ts add \"Acme Bakery\"`";

class ClientCliUsageError extends Error {
  constructor(detail: string) {
    super(`${detail}\n${USAGE}`);
    this.name = "ClientCliUsageError";
  }
}

/** The access code offered is too short to guard a login. Carries the length only. */
class AccessCodeTooShort extends Error {
  constructor(readonly length: number) {
    super(
      `refusing an access code of ${length} characters: at least ${MIN_CLIENT_ACCESS_CODE_LENGTH} are required ` +
        "(e.g. `openssl rand -base64 24`). Nothing was changed.",
    );
    this.name = "AccessCodeTooShort";
  }
}

/** A command named a client that does not exist. */
class ClientNotFound extends Error {
  constructor(readonly clientName: string) {
    super(`no client named "${clientName}"; \`npx tsx scripts/client.ts list\` shows the names. Nothing was changed.`);
    this.name = "ClientNotFound";
  }
}

/** The name a client logs in with: trimmed, 1-200 characters (the login accepts at most 200). */
function parseClientName(raw: string | undefined, command: string): string {
  const name = raw?.trim();
  if (name === undefined || name.length < 1 || name.length > 200) {
    throw new ClientCliUsageError(`${command} needs a client name of 1-200 characters.`);
  }
  return name;
}

/** The key loads before stdin is read, so a missing key fails before the code is typed. */
async function readAccessCode(command: string): Promise<{ key: MasterKey; code: string }> {
  const key = loadMasterKey(resolveKeyFilePath(process.env));
  const code = await readPipedStdin(`client.ts ${command}`);
  if (code.length < MIN_CLIENT_ACCESS_CODE_LENGTH) throw new AccessCodeTooShort(code.length);
  return { key, code };
}

async function requireClient(clients: ClientRepository, clientName: string): Promise<{ id: string; name: string }> {
  const client = await clients.findByName(clientName);
  if (client === null) throw new ClientNotFound(clientName);
  return client;
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
        const clientName = parseClientName(name, command);
        const { key, code } = await readAccessCode(command);
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
      case "set-code": {
        const clientName = parseClientName(name, command);
        const client = await requireClient(new ClientRepository(db), clientName);
        const { key, code } = await readAccessCode(command);
        const ended = await db.transaction(async (tx) => {
          await new SecretStore(new SecretRepository(tx), key).put(clientAccessCodeSecretName(client.id), code);
          return new ClientSessionRepository(tx).deleteByClient(client.id);
        });
        console.log(
          `Stored a new access code for client "${client.name}" (${client.id}) as ` +
            `"${clientAccessCodeSecretName(client.id)}" under key ${key.id}; deleted ${ended} session(s).`,
        );
        return;
      }
      case "remove-code": {
        const client = await requireClient(new ClientRepository(db), parseClientName(name, command));
        const secretName = clientAccessCodeSecretName(client.id);
        const { removed, ended } = await db.transaction(async (tx) => ({
          removed: await new SecretRepository(tx).delete(secretName),
          ended: await new ClientSessionRepository(tx).deleteByClient(client.id),
        }));
        console.log(
          `${removed ? `Removed the access code "${secretName}"` : `No access code was stored as "${secretName}"`} ` +
            `for client "${client.name}" (${client.id}); deleted ${ended} session(s). It cannot log in until set-code.`,
        );
        return;
      }
      case "revoke-sessions": {
        const client = await requireClient(new ClientRepository(db), parseClientName(name, command));
        const ended = await new ClientSessionRepository(db).deleteByClient(client.id);
        console.log(`Deleted ${ended} session(s) of client "${client.name}" (${client.id}).`);
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
  console.error(`\n${describeErrorChain(err)}\n`);
  process.exit(1);
});

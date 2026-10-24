// Whether a failed query failed because the database could not be reached, which a later attempt may
// not meet, as against anything else (a row that does not parse, a constraint, Ashara's own code),
// which a retry meets again. Named positively: only a fault recognised here is the connection's, so an
// error nothing names is never taken for a passing outage. node-postgres (the pinned pg)
// gives its own connection failures no code, only a message; connection-fault.test.ts provokes each
// kind on a real connection, so an upgrade that renames one fails there.

/** Socket failures Node reports under `code` while reaching or talking to the server. */
const SOCKET_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * SQLSTATEs of a server that dropped or refused the session: class 08 (connection exception),
 * 57P01-57P03 (admin or crash shutdown, cannot connect now), 53300 (too many connections).
 */
function isConnectionSqlState(code: string): boolean {
  return /^08[0-9A-Z]{3}$/.test(code) || code === "57P01" || code === "57P02" || code === "57P03" || code === "53300";
}

/** node-postgres's and pg-pool's own connection failures, which carry no code (pg/lib/client.js, pg-pool/index.js). */
const DRIVER_CONNECTION_MESSAGES: readonly string[] = [
  "Connection terminated",
  "timeout exceeded when trying to connect",
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
];

const MAX_CAUSE_DEPTH = 8;

/** True when `error`, or an error in its cause chain, is the database being unreachable. */
export function isDatabaseConnectionFault(error: unknown): boolean {
  let layer: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && layer instanceof Error; depth++) {
    const code = "code" in layer && typeof layer.code === "string" ? layer.code : null;
    if (code !== null && (SOCKET_CODES.has(code) || isConnectionSqlState(code))) return true;
    if (DRIVER_CONNECTION_MESSAGES.some((message) => layer instanceof Error && layer.message.startsWith(message))) return true;
    layer = layer.cause;
  }
  return false;
}

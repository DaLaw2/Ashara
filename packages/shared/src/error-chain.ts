/**
 * A thrown non-Error as text. JSON.stringify throws on a circular value or a
 * BigInt and returns undefined for a function or symbol; the description must
 * never throw, or the failed attempt it describes would go uncounted.
 */
function describeNonError(value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (stringifyError) {
    const reason = stringifyError instanceof Error ? stringifyError.message : "unknown reason";
    const kind = value === null ? "null" : typeof value === "object" ? (value.constructor?.name ?? "object") : typeof value;
    return `${kind} (not serializable: ${reason})`;
  }
  return json ?? String(value);
}

/**
 * The error chain as one line, every cause's name and message kept, for a
 * durable record of a failed attempt (Discipline C: no lossy `toString`).
 */
export function describeErrorChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current !== undefined && parts.length < 8) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      current = current.cause;
    } else {
      parts.push(`non-Error thrown: ${describeNonError(current)}`);
      break;
    }
  }
  return parts.join(" <- caused by ");
}

/** An operator tool was asked to read a secret from a terminal, where it would echo. */
class StdinIsTerminal extends Error {
  constructor(readonly tool: string) {
    super(`${tool} refuses to read the value from a terminal, where it would echo; pipe it in.`);
    this.name = "StdinIsTerminal";
  }
}

/**
 * The whole of piped stdin, one trailing newline stripped. Secrets come from
 * stdin, never argv, so they land in neither shell history nor `ps`.
 */
export async function readPipedStdin(tool: string): Promise<string> {
  if (process.stdin.isTTY) throw new StdinIsTerminal(tool);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8").replace(/\r?\n$/, "");
}

/** One scripted tool call of an agent turn: the tool's name and its input. */
export type ToolStep = readonly [toolName: string, input: unknown];

export function finished(summary: string): ToolStep {
  return ["finish", { status: "done", summary }];
}

/** A blocked finish whose cause names the owner who can clear it. */
export function blockedOn(summary: string, cause: Readonly<Record<string, unknown>>): ToolStep {
  return ["finish", { status: "blocked", summary, blockedReason: summary, blockedOn: cause }];
}

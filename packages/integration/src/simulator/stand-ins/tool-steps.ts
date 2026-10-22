/** One scripted tool call of an agent turn: the tool's name and its input. */
export type ToolStep = readonly [toolName: string, input: unknown];

export function finished(summary: string): ToolStep {
  return ["finish", { status: "done", summary }];
}

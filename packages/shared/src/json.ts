import type { z } from "zod";

/** Characters of the rejected text a JsonParseFailed keeps, so its message locates the input without carrying all of it. */
const EXCERPT_CHARS = 200;

/** One schema issue of a JSON value, as `path: message` (`(root)` for the value itself). */
function issueLine(issue: z.ZodError["issues"][number]): string {
  return `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`;
}

/**
 * A text that was to become a value and is not one: `syntax` when it is not JSON at all, `schema`
 * when it is JSON of another shape. `source` names where the text came from (a command's stdout, a
 * file, a model response), so the message alone locates the bad input.
 */
export class JsonParseFailed extends Error {
  readonly source: string;
  readonly stage: "syntax" | "schema";
  /** Each schema issue as `path: message`; empty for a syntax failure. */
  readonly issues: readonly string[];
  /** What the parser or the schema said was wrong, without the text. */
  readonly detail: string;
  readonly excerpt: string;

  constructor(source: string, stage: "syntax" | "schema", detail: string, issues: readonly string[], text: string, options?: ErrorOptions) {
    const excerpt = text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS)}[${text.length - EXCERPT_CHARS} more characters]`;
    super(`${source}: ${stage === "syntax" ? "not JSON" : "JSON of an unexpected shape"}: ${detail}; text: ${JSON.stringify(excerpt)}`, options);
    this.name = "JsonParseFailed";
    this.source = source;
    this.stage = stage;
    this.issues = issues;
    this.detail = detail;
    this.excerpt = excerpt;
  }
}

/**
 * The one way a JSON text becomes a value (CLAUDE.md: Zod at every boundary): parsed, then
 * validated by `schema`. Throws JsonParseFailed for text that is not JSON or not of the shape.
 */
export function parseJson<S extends z.ZodType>(schema: S, text: string, source: string): z.output<S> {
  let json: unknown;
  try {
    // eslint-disable-next-line no-restricted-syntax -- the one JSON.parse: its value is validated by `schema` below
    json = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new JsonParseFailed(source, "syntax", err.message, [], text, { cause: err });
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(issueLine);
  throw new JsonParseFailed(source, "schema", issues.join("; "), issues, text, { cause: parsed.error });
}

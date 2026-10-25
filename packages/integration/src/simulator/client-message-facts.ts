/**
 * The facts a client message carries, read without its wording: the paragraphs it is told in, the ids
 * and commits it cites, the amounts and counts it states, the titles its bullet lines name, and the key
 * terms that name a kind no id or figure can carry. An oracle judges a message by these and never by an
 * expected whole sentence, so a message reworded around the same facts reads the same, and one whose
 * fact is wrong, missing or contradicted does not.
 */

/** A message's paragraphs, as it separates them by a blank line. */
export function paragraphsOf(body: string): string[] {
  return body.split("\n\n");
}

/**
 * `body` without its fenced blocks: a quoted file or command is text the message quotes, whose lines
 * state none of the message's own facts.
 */
export function outsideFences(body: string): string {
  let fence: string | null = null;
  const kept: string[] = [];
  for (const line of body.split("\n")) {
    if (fence === null && /^`{3,}$/.test(line)) fence = line;
    else if (fence !== null && line === fence) fence = null;
    else if (fence === null) kept.push(line);
  }
  return kept.join("\n");
}

/** A message's opening paragraph: the whole message when it has one paragraph. */
export function openingOf(body: string): string {
  const at = body.indexOf("\n\n");
  return at < 0 ? body : body.slice(0, at);
}

/** The lines of a text that are not list items: what introduces or states its facts in prose. */
export function leadOf(part: string): string {
  return part
    .split("\n")
    .filter((line) => !line.startsWith("- "))
    .join("\n");
}

/** `text` with every double-quoted span emptied: a quoted title or call site carries no term or figure of its own. */
function unquoted(text: string): string {
  return text.replace(/"[^"\n]*"/g, `""`);
}

function escaped(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `token` stands in `text` as a whole token, not as part of a longer id, word or number. */
export function cites(text: string, token: string): boolean {
  return new RegExp(`(?<![\\w-])${escaped(token)}(?![\\w-])`).test(text);
}

/** The tokens of `tokens` that `text` cites, each once, in the order given. */
export function citedOf(text: string, tokens: readonly string[]): string[] {
  return [...new Set(tokens)].filter((token) => cites(text, token));
}

/** A term: words said as words, any whitespace between them; `|` separates the forms any one of which says it. */
function termPattern(term: string, flags: string): RegExp {
  const forms = term.split("|").map((form) => escaped(form).replace(/ /g, "\\s+"));
  return new RegExp(`(?<!\\w)(?:${forms.join("|")})(?!\\w)`, flags);
}

/** How many times `text`, outside its quoted spans, says `term` as words, in any case. */
export function timesSaid(text: string, term: string): number {
  return [...unquoted(text).matchAll(termPattern(term, "gi"))].length;
}

/** Whether `text`, outside its quoted spans, says every one of `terms` as words, in any case. */
export function says(text: string, terms: readonly string[]): boolean {
  return terms.every((term) => timesSaid(text, term) > 0);
}

/**
 * The key terms that tell one kind of a fact from every other kind a message may state: each of `all`
 * said, and none of `none`.
 */
export interface Signature {
  readonly all: readonly string[];
  readonly none?: readonly string[];
}

/** Every kind of `kinds` whose signature `text` carries, in the order of `kinds`. */
export function kindsSaid<K extends string>(
  text: string,
  kinds: readonly K[],
  signatures: Readonly<Record<K, Signature>>,
): K[] {
  return kinds.filter((kind) => {
    const { all, none } = signatures[kind];
    /* eslint-disable-next-line no-restricted-syntax -- policy default: a signature naming no term to refuse
       refuses none */
    return says(text, all) && !(none ?? []).some((term) => timesSaid(text, term) > 0);
  });
}

/** The amounts in USD `text` states outside its quoted spans, in order. */
export function usdAmounts(text: string): number[] {
  return [...unquoted(text).matchAll(/\$(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
}

/** Whether two lists of USD amounts are the same, each to the micro-dollar a message states. */
export function sameAmounts(said: readonly number[], expected: readonly number[]): boolean {
  return said.length === expected.length && said.every((amount, i) => Math.abs(amount - (expected[i] ?? NaN)) < 5e-7);
}

/** A whole number standing as a figure: not part of an id, a version, a commit or an amount. */
const FIGURE = /(?<![\w$.-])\d+(?![\w-]|\.\d)/g;

/**
 * The figures `text` states, in order: its whole numbers outside its quoted spans, its USD amounts and
 * each of `ids`, which may hold digits of their own.
 */
export function figuresOf(text: string, ids: readonly string[] = []): number[] {
  let plain = unquoted(text).replace(/\$\d+(?:\.\d+)?/g, " ");
  for (const id of ids) plain = plain.replace(new RegExp(`(?<![\\w-])${escaped(id)}(?![\\w-])`, "g"), " ");
  return [...plain.matchAll(FIGURE)].map((match) => Number(match[0]));
}

/** The counts `text` states of `unit`: each whole number standing directly before it, singular or plural. */
export function countsOf(text: string, unit: string): number[] {
  const pattern = new RegExp(`(?<![\\w$.-])(\\d+) ${escaped(unit).replace(/ /g, "\\s+")}s?(?!\\w)`, "gi");
  return [...unquoted(text).matchAll(pattern)].map((match) => Number(match[1]));
}

/**
 * Whether `text` carries `fact`, a text the records hold (a title, a statement) rather than one an
 * oracle composes: a recorded fact is carried verbatim whatever the message says around it.
 */
export function carries(text: string, fact: string): boolean {
  return fact.length > 0 && text.includes(fact);
}

/** `text` with the first span carrying `fact` left out: what the text states besides that recorded fact. */
export function besides(text: string, fact: string): string {
  const at = fact.length === 0 ? -1 : text.indexOf(fact);
  return at < 0 ? text : `${text.slice(0, at)} ${text.slice(at + fact.length)}`;
}

/** The double-quoted spans of `text`, in order. */
export function quotedOf(text: string): string[] {
  return [...text.matchAll(/"([^"\n]*)"/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

/** The lines of a text that name a task by its title (`- "<title>"...`), in order. */
export function namedLines(text: string | null): string[] {
  return text === null ? [] : text.split("\n").filter((line) => line.startsWith(`- "`));
}

/** Whether a named line names `title`. */
export function namesTitle(line: string, title: string): boolean {
  return line.startsWith(`- "${title}"`);
}

/** What a named line states after the title it names: its facts, the title left out. */
export function afterTitle(line: string, title: string): string {
  return line.slice(`- "${title}"`.length);
}

/** The ids at the head of a text's `- <id>: ` lines, in order. */
export function idsListed(text: string | null): string[] {
  return text === null
    ? []
    : text.split("\n").flatMap((line) => {
        const id = /^- ([A-Za-z]+\d+): /.exec(line)?.[1];
        return id === undefined ? [] : [id];
      });
}

/** The paragraphs of `body` whose lead (its lines that are not list items) says every one of `terms`. */
export function paragraphsSaying(body: string, terms: readonly string[]): string[] {
  return paragraphsOf(body).filter((part) => says(leadOf(part), terms));
}

/** The paragraphs of `body` that cite `token`. */
export function paragraphsCiting(body: string, token: string): string[] {
  return paragraphsOf(body).filter((part) => cites(part, token));
}

/** The git commits `text` cites: each token of 7 to 40 hex digits standing on its own, in order. */
export function commitsCited(text: string): string[] {
  return [...text.matchAll(/(?<![\w-])[0-9a-f]{7,40}(?![\w-])/g)].map((match) => match[0]);
}

/** The record ids `text` cites outside its quoted spans, each token mixing letters and digits, in order. */
export function recordIdsCited(text: string): string[] {
  const tokens = unquoted(text).matchAll(/(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]+(?![\w-])/g);
  return [...tokens].map((match) => match[0]);
}

/** The vision versions `text` cites (`v<n>`), each once, in order. */
export function versionsCited(text: string): number[] {
  return [...new Set([...unquoted(text).matchAll(/(?<![\w-])v(\d+)(?![\w-])/g)].map((match) => Number(match[1])))];
}

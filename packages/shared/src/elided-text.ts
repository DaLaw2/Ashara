/**
 * A text some of whose characters may have been cut, each cut kept as the number of characters it removed. Cutting
 * again composes the counts, so however many caps a text passes through, what its reader is told is the exact
 * number of characters missing at each place.
 */
type TextPiece = { readonly kind: "kept"; readonly text: string } | { readonly kind: "cut"; readonly chars: number };

export type ElidedText = readonly TextPiece[];

/** Share of a budget kept from a text's start; the rest is kept from its end, where a build or test run reports its verdict. */
const HEAD_SHARE = 0.4;

/** How much of a `limit` a cut keeps from the start; `limit - headBudget(limit)` is kept from the end. */
export function headBudget(limit: number): number {
  return Math.floor(limit * HEAD_SHARE);
}

export function wholeText(text: string): ElidedText {
  return text === "" ? [] : [{ kind: "kept", text }];
}

/** Concatenates texts in order, merging adjacent kept text and adjacent cuts. */
export function joinElided(parts: readonly ElidedText[]): ElidedText {
  const out: TextPiece[] = [];
  for (const piece of parts.flat()) {
    if (piece.kind === "kept" ? piece.text === "" : piece.chars === 0) continue;
    const last = out.at(-1);
    if (last?.kind === "kept" && piece.kind === "kept") out[out.length - 1] = { kind: "kept", text: last.text + piece.text };
    else if (last?.kind === "cut" && piece.kind === "cut") out[out.length - 1] = { kind: "cut", chars: last.chars + piece.chars };
    else out.push(piece);
  }
  return out;
}

function shownChars(text: ElidedText): number {
  return text.reduce((sum, piece) => sum + (piece.kind === "kept" ? piece.text.length : 0), 0);
}

function totalChars(text: ElidedText): number {
  return text.reduce((sum, piece) => sum + (piece.kind === "kept" ? piece.text.length : piece.chars), 0);
}

/** The kept characters only, without any marker: for a test of content such as "printed nothing". */
export function shownText(text: ElidedText): string {
  return text.map((piece) => (piece.kind === "kept" ? piece.text : "")).join("");
}

/** The text itself when nothing was cut from it; null when anything was. */
export function uncutText(text: ElidedText): string | null {
  return text.every((piece) => piece.kind === "kept") ? shownText(text) : null;
}

/** The pieces from the start holding `budget` kept characters; a cut met before the budget is spent is kept too. */
function front(text: ElidedText, budget: number): TextPiece[] {
  const out: TextPiece[] = [];
  let left = budget;
  for (const piece of text) {
    if (left === 0) break;
    if (piece.kind === "cut") {
      out.push(piece);
      continue;
    }
    const take = Math.min(left, piece.text.length);
    out.push({ kind: "kept", text: piece.text.slice(0, take) });
    left -= take;
  }
  return out;
}

function back(text: ElidedText, budget: number): TextPiece[] {
  const out: TextPiece[] = [];
  let left = budget;
  for (let i = text.length - 1; i >= 0 && left > 0; i--) {
    const piece = text[i];
    if (piece.kind === "cut") {
      out.unshift(piece);
      continue;
    }
    const take = Math.min(left, piece.text.length);
    out.unshift({ kind: "kept", text: piece.text.slice(piece.text.length - take) });
    left -= take;
  }
  return out;
}

/**
 * Keeps at most `limit` characters of `text`: its first headBudget(limit) and its last rest. What lies between them,
 * kept characters and earlier cuts alike, becomes one cut counting all of it.
 */
export function keepEnds(text: ElidedText, limit: number): ElidedText {
  if (shownChars(text) <= limit) return text;
  const head = front(text, headBudget(limit));
  const tail = back(text, limit - headBudget(limit));
  const middle = totalChars(text) - totalChars(head) - totalChars(tail);
  return joinElided([head, [{ kind: "cut", chars: middle }], tail]);
}

/** The text as its reader sees it: every cut is a marker line stating how many characters were cut there. */
export function renderElided(text: ElidedText): string {
  let out = "";
  for (const piece of text) {
    if (piece.kind === "kept") {
      out += piece.text;
      continue;
    }
    const before = out === "" || out.endsWith("\n") ? "" : "\n";
    out += `${before}[truncated by Ashara: ${piece.chars} characters cut here]\n`;
  }
  return out;
}

/** `text` cut to at most `limit` characters, keeping both ends, as its reader sees it. */
export function cutText(text: string, limit: number): string {
  return renderElided(keepEnds(wholeText(text), limit));
}

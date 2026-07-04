import { z } from "zod";

export interface ProposalEmbedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface DedupCandidate {
  readonly title: string;
  readonly description: string;
}

export type DedupMethod = "exact_title" | "embedding" | "lexical";

export interface DroppedProposal {
  readonly title: string;
  readonly matchedTitle: string;
  readonly method: DedupMethod;
  readonly similarity: number;
}

export interface DedupOutcome<T extends DedupCandidate> {
  readonly unique: T[];
  readonly dropped: DroppedProposal[];
}

/** Cosine similarity above which two embedded proposals are duplicates. */
export const SEMANTIC_SIMILARITY_THRESHOLD = 0.85;

/** Token-overlap coefficient above which two proposals are lexical duplicates. */
export const LEXICAL_SIMILARITY_THRESHOLD = 0.6;

const MIN_SHARED_TITLE_TOKENS = 2;
const MIN_SHARED_COMBINED_TOKENS = 3;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for",
  "with", "by", "from", "into", "is", "are", "be", "as", "it", "its",
  "this", "that", "these", "those", "use", "using", "used", "new",
  "our", "all", "any", "some", "up", "so", "should", "will", "must",
  "can", "we", "when", "then", "than",
]);

/** Stems of creation/initialization verbs collapsed to one canonical token,
 * so "Create X", "Implement X", "Initialize X", "Set up X" compare as equivalent. */
const CREATION_STEMS = new Set([
  "creat", "init", "initi", "initial", "initialis", "implement",
  "build", "add", "set", "setup", "make", "establish", "bootstrap",
  "scaffold", "generat", "writ", "develop",
]);

const SUFFIXES = [
  "ization", "isation", "izing", "ising", "ized", "ised", "izes", "ises",
  "ize", "ise", "ings", "ing", "ions", "ion", "ities", "ity", "ies",
  "ial", "ers", "er", "ed", "es", "s", "e",
];

const embeddingMatrixSchema = z.array(z.array(z.number().finite()).min(1));

class ProposalDedupError extends Error {
  readonly operation: string;
  readonly expected: string;
  readonly actual: string;

  constructor(operation: string, expected: string, actual: string) {
    super(`Proposal dedup ${operation} failed: expected ${expected}, got ${actual}`);
    this.name = "ProposalDedupError";
    this.operation = operation;
    this.expected = expected;
    this.actual = actual;
  }
}

function stemToken(token: string): string {
  for (const suffix of SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

function normalizeTokens(text: string): Set<string> {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const result = new Set<string>();
  for (const raw of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const stem = stemToken(raw);
    if (stem.length < 2 || STOPWORDS.has(stem)) continue;
    result.add(CREATION_STEMS.has(stem) ? "init" : stem);
  }
  return result;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().trim();
}

function candidateText(candidate: DedupCandidate): string {
  return `${candidate.title}\n${candidate.description}`.trim();
}

interface LexicalProfile {
  readonly title: string;
  readonly titleTokens: Set<string>;
  readonly combinedTokens: Set<string>;
}

function buildProfile(candidate: DedupCandidate): LexicalProfile {
  return {
    title: candidate.title,
    titleTokens: normalizeTokens(candidate.title),
    combinedTokens: normalizeTokens(candidateText(candidate)),
  };
}

function overlapCoefficient(
  a: Set<string>,
  b: Set<string>,
): { score: number; shared: number } {
  if (a.size === 0 || b.size === 0) return { score: 0, shared: 0 };
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return { score: shared / Math.min(a.size, b.size), shared };
}

/** Returns 0 when not a duplicate, otherwise the qualifying similarity score. */
function lexicalDuplicateScore(a: LexicalProfile, b: LexicalProfile): number {
  const title = overlapCoefficient(a.titleTokens, b.titleTokens);
  const combined = overlapCoefficient(a.combinedTokens, b.combinedTokens);
  let score = 0;
  if (title.shared >= MIN_SHARED_TITLE_TOKENS && title.score >= LEXICAL_SIMILARITY_THRESHOLD) {
    score = Math.max(score, title.score);
  }
  if (combined.shared >= MIN_SHARED_COMBINED_TOKENS && combined.score >= LEXICAL_SIMILARITY_THRESHOLD) {
    score = Math.max(score, combined.score);
  }
  return score;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new ProposalDedupError(
      "cosine_similarity",
      `matching vector dimensions`,
      `${a.length} vs ${b.length}`,
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0 || !Number.isFinite(denom)) {
    throw new ProposalDedupError("cosine_similarity", "non-zero finite vector norms", `denominator ${denom}`);
  }
  return dot / denom;
}

async function semanticDedup<T extends DedupCandidate>(
  proposals: readonly T[],
  existingItems: readonly DedupCandidate[],
  embedder: ProposalEmbedder,
): Promise<DedupOutcome<T>> {
  const texts = [...existingItems, ...proposals].map(candidateText);
  const vectors = embeddingMatrixSchema.parse(await embedder.embed(texts));
  if (vectors.length !== texts.length) {
    throw new ProposalDedupError("embedding", `${texts.length} vectors`, `${vectors.length} vectors`);
  }

  const accepted = existingItems.map((item, i) => ({ title: item.title, vector: vectors[i]! }));
  const unique: T[] = [];
  const dropped: DroppedProposal[] = [];

  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i]!;
    const vector = vectors[existingItems.length + i]!;
    let best: { title: string; similarity: number } | null = null;
    for (const candidate of accepted) {
      const similarity = cosineSimilarity(vector, candidate.vector);
      if (best === null || similarity > best.similarity) {
        best = { title: candidate.title, similarity };
      }
    }
    if (best !== null && best.similarity >= SEMANTIC_SIMILARITY_THRESHOLD) {
      dropped.push({
        title: proposal.title,
        matchedTitle: best.title,
        method: "embedding",
        similarity: best.similarity,
      });
    } else {
      accepted.push({ title: proposal.title, vector });
      unique.push(proposal);
    }
  }

  return { unique, dropped };
}

function lexicalDedup<T extends DedupCandidate>(
  proposals: readonly T[],
  existingItems: readonly DedupCandidate[],
): DedupOutcome<T> {
  const accepted = existingItems.map(buildProfile);
  const unique: T[] = [];
  const dropped: DroppedProposal[] = [];

  for (const proposal of proposals) {
    const profile = buildProfile(proposal);
    let best: { title: string; similarity: number } | null = null;
    for (const candidate of accepted) {
      const score = lexicalDuplicateScore(profile, candidate);
      if (score > 0 && (best === null || score > best.similarity)) {
        best = { title: candidate.title, similarity: score };
      }
    }
    if (best !== null) {
      dropped.push({
        title: proposal.title,
        matchedTitle: best.title,
        method: "lexical",
        similarity: best.similarity,
      });
    } else {
      accepted.push(profile);
      unique.push(proposal);
    }
  }

  return { unique, dropped };
}

/**
 * Filters brainstorm proposals that duplicate existing work items or earlier
 * proposals in the same batch. Exact normalized-title matches are dropped first;
 * survivors are compared semantically via the embedder when one is available,
 * degrading to lexical token-overlap when the embedder is null or its call
 * fails — dedup itself never gets skipped.
 */
export async function dedupeProposals<T extends DedupCandidate>(
  proposals: readonly T[],
  existingItems: readonly DedupCandidate[],
  embedder: ProposalEmbedder | null,
): Promise<DedupOutcome<T>> {
  const dropped: DroppedProposal[] = [];
  const titlesSeen = new Map<string, string>();
  for (const item of existingItems) {
    const normalized = normalizeTitle(item.title);
    if (!titlesSeen.has(normalized)) titlesSeen.set(normalized, item.title);
  }

  const candidates: T[] = [];
  for (const proposal of proposals) {
    const normalized = normalizeTitle(proposal.title);
    const matchedTitle = titlesSeen.get(normalized);
    if (matchedTitle !== undefined) {
      dropped.push({ title: proposal.title, matchedTitle, method: "exact_title", similarity: 1 });
      continue;
    }
    titlesSeen.set(normalized, proposal.title);
    candidates.push(proposal);
  }

  if (candidates.length === 0) return { unique: [], dropped };

  if (embedder !== null) {
    try {
      const semantic = await semanticDedup(candidates, existingItems, embedder);
      return { unique: semantic.unique, dropped: [...dropped, ...semantic.dropped] };
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.warn(
        `Proposal dedup embedding path failed (${detail}); degrading to lexical similarity`,
      );
    }
  }

  const lexical = lexicalDedup(candidates, existingItems);
  return { unique: lexical.unique, dropped: [...dropped, ...lexical.dropped] };
}

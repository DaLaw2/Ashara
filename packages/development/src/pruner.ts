/**
 * Goal-conditioned pruning: removes irrelevant context chunks to reduce token
 * budget while preserving quality.  Scoring is fully deterministic (no LLM calls).
 */

import type { RetrievalResult } from "@ashara/memory";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PrunerConfig {
    readonly maxTokens: number;
    readonly minRelevanceScore: number;
    readonly preserveSyntax: boolean;
}

export interface PrunedChunk {
    readonly filePath: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly content: string;
    readonly relevanceScore: number;
    readonly source: string;
    readonly tokenCount: number;
    readonly pruned: boolean;
}

export interface PruningResult {
    readonly chunks: PrunedChunk[];
    readonly totalTokens: number;
    readonly originalTokens: number;
    readonly tokenReduction: number;
    readonly droppedCount: number;
    readonly prunedCount: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// Shared with brief-assembly.ts's checkRelevance, which gates on the same raw
// retrieval score — a single floor closes a prior 0.3-vs-0.1 mismatch between
// the two.
export const DEFAULT_MIN_RELEVANCE = 0.3;
const DEFAULT_PRESERVE_SYNTAX = true;

// ---------------------------------------------------------------------------
// Token estimation (matches packages/memory chunker convention)
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Syntax-aware splitting
// ---------------------------------------------------------------------------

/** Patterns that indicate the start of a top-level declaration. */
const SYNTAX_BOUNDARY_PATTERNS = [
    /^export\s/,
    /^(pub\s+)?(async\s+)?fn\s/,
    /^(pub\s+)?struct\s/,
    /^(pub\s+)?impl\s/,
    /^(pub\s+)?trait\s/,
    /^(pub\s+)?enum\s/,
    /^(pub\s+)?mod\s/,
    /^(async\s+)?function\s/,
    /^class\s/,
    /^interface\s/,
    /^type\s/,
    /^const\s/,
    /^let\s/,
    /^def\s/,
];

function isSyntaxBoundary(line: string): boolean {
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        return false;
    }
    // Only consider top-level declarations (no leading whitespace)
    const leadingWhitespace = line.length - line.trimStart().length;
    if (leadingWhitespace > 0) return false;
    return SYNTAX_BOUNDARY_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Split a chunk at syntax-safe points: empty lines between top-level
 * declarations, or lines that start a new declaration keyword.
 *
 * Returns sub-blocks that can each be independently scored.
 */
export function splitAtSyntaxBoundaries(content: string): string[] {
    const lines = content.split("\n");
    if (lines.length === 0) return [];

    const blocks: string[] = [];
    let current: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Start a new block on a syntax boundary when we already have content
        if (isSyntaxBoundary(line) && current.length > 0) {
            blocks.push(current.join("\n"));
            current = [line];
        } else if (line.trim() === "" && current.length > 0) {
            // An empty line between blocks: peek ahead to see if a boundary follows
            const nextNonEmpty = lines.slice(i + 1).find((l) => l.trim() !== "");
            if (nextNonEmpty !== undefined && isSyntaxBoundary(nextNonEmpty)) {
                current.push(line);
                blocks.push(current.join("\n"));
                current = [];
            } else {
                current.push(line);
            }
        } else {
            current.push(line);
        }
    }

    if (current.length > 0) {
        const text = current.join("\n");
        if (text.trim().length > 0) {
            blocks.push(text);
        }
    }

    return blocks.filter((b) => b.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Main pruning pipeline
// ---------------------------------------------------------------------------

interface ScoredChunk {
    readonly original: RetrievalResult;
    relevanceScore: number;
    content: string;
    tokenCount: number;
    pruned: boolean;
}

/**
 * Prune retrieval results by trusting the upstream retrieval score rather than
 * computing an independent relevance model.
 *
 * Steps:
 *  1. Sort chunks by their upstream retrieval score, descending
 *  2. Drop chunks below the relevance threshold
 *  3. If over token budget, trim lowest-scored chunks at syntax boundaries
 *  4. If still over budget, drop lowest-scored chunks
 */
export function pruneContext(
    chunks: readonly RetrievalResult[],
    config: Partial<PrunerConfig> = {},
): PruningResult {
    const maxTokens = config.maxTokens ?? Infinity;
    const minRelevance = config.minRelevanceScore ?? DEFAULT_MIN_RELEVANCE;
    const preserveSyntax = config.preserveSyntax ?? DEFAULT_PRESERVE_SYNTAX;

    const originalTokens = chunks.reduce((sum, c) => sum + estimateTokens(c.content), 0);

    if (chunks.length === 0) {
        return {
            chunks: [],
            totalTokens: 0,
            originalTokens: 0,
            tokenReduction: 0,
            droppedCount: 0,
            prunedCount: 0,
        };
    }

    // 1. Use the upstream retrieval score directly, sorted descending
    const scored: ScoredChunk[] = chunks
        .map((chunk) => ({
            original: chunk,
            relevanceScore: chunk.score,
            content: chunk.content,
            tokenCount: estimateTokens(chunk.content),
            pruned: false,
        }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore);

    // 2. Drop chunks below threshold
    let kept = scored.filter((s) => s.relevanceScore >= minRelevance);
    let droppedCount = scored.length - kept.length;

    // 3. If remaining tokens exceed budget, try trimming then dropping
    let totalTokens = kept.reduce((sum, s) => sum + s.tokenCount, 0);
    let prunedCount = 0;

    if (totalTokens > maxTokens && preserveSyntax) {
        // Attempt syntax-aware trimming on lowest-scored kept chunks (from bottom)
        for (let i = kept.length - 1; i >= 0 && totalTokens > maxTokens; i--) {
            const chunk = kept[i];
            const subBlocks = splitAtSyntaxBoundaries(chunk.content);

            if (subBlocks.length <= 1) continue;

            // No per-sub-block relevance signal exists (all sub-blocks share the
            // parent chunk's retrieval score) — drop trailing blocks, preserving
            // declaration order, until enough tokens are saved.
            const tokensToSave = totalTokens - maxTokens;
            let droppedTokens = 0;
            const keptBlocks: string[] = [];
            for (let j = subBlocks.length - 1; j >= 0; j--) {
                if (droppedTokens >= tokensToSave) {
                    keptBlocks.unshift(subBlocks[j]);
                    continue;
                }
                droppedTokens += estimateTokens(subBlocks[j]);
            }

            if (keptBlocks.length > 0 && keptBlocks.length < subBlocks.length) {
                const newContent = keptBlocks.join("\n\n");
                const newTokens = estimateTokens(newContent);
                totalTokens = totalTokens - chunk.tokenCount + newTokens;
                chunk.content = newContent;
                chunk.tokenCount = newTokens;
                chunk.pruned = true;
                prunedCount++;
            }
        }
    }

    // 4. If still over budget, drop lowest-scored chunks
    while (totalTokens > maxTokens && kept.length > 1) {
        const removed = kept.pop();
        if (removed) {
            totalTokens -= removed.tokenCount;
            droppedCount++;
        }
    }

    const resultChunks: PrunedChunk[] = kept.map((s) => ({
        filePath: s.original.filePath,
        startLine: s.original.startLine,
        endLine: s.original.endLine,
        content: s.content,
        relevanceScore: s.relevanceScore,
        source: s.original.source,
        tokenCount: s.tokenCount,
        pruned: s.pruned,
    }));

    const finalTokens = resultChunks.reduce((sum, c) => sum + c.tokenCount, 0);
    const reduction = originalTokens > 0 ? (originalTokens - finalTokens) / originalTokens : 0;

    return {
        chunks: resultChunks,
        totalTokens: finalTokens,
        originalTokens,
        tokenReduction: reduction,
        droppedCount,
        prunedCount,
    };
}

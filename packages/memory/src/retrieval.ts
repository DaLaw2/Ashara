/**
 * Two-route retrieval orchestrator: graph + keyword (BM25).
 *
 * The semantic (embedding) and in-`retrieve()` knowledge routes were removed —
 * the semantic route's backing embedding table is never written (nothing
 * populates it), and the knowledge route duplicated a channel (the db-repo-
 * based `knowledgeContext`) that already works independently.
 */

import type { GraphClient, GraphTraversalResult, KeywordResult } from "./graph-client.js";

export interface RetrievalResult {
    readonly filePath: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly content: string;
    readonly source: "graph" | "semantic" | "keyword" | "knowledge";
    readonly score: number;
}

export interface RankedResult {
    readonly index: number;
    readonly score: number;
    readonly document: string;
}

/** Reranks candidate documents against a query, e.g. for the fusion step below */
export interface Reranker {
    rerank(query: string, documents: string[]): Promise<RankedResult[]>;
}

export interface RetrievalConfig {
    readonly graphClient: GraphClient;
    readonly reranker: Reranker;
    readonly graphHops: number;
    readonly keywordTopK: number;
    readonly finalTopK: number;
}

/** Deduplication key: file path + start line */
function dedupKey(filePath: string, startLine: number): string {
    return `${filePath}:${startLine}`;
}

/** Convert graph traversal results to retrieval results (need file content from signature or placeholder) */
function graphResultsToRetrieval(results: GraphTraversalResult[]): RetrievalResult[] {
    return results.map((r) => ({
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
        content: r.signature ?? `${r.symbolKind} ${r.symbolName}`,
        source: "graph" as const,
        score: 1.0 / (1.0 + r.distance),
    }));
}

/** Convert keyword search results to retrieval results */
function keywordResultsToRetrieval(results: KeywordResult[]): RetrievalResult[] {
    return results.map((r) => ({
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
        content: `${r.symbolKind} ${r.symbolName}`,
        source: "keyword" as const,
        score: r.score,
    }));
}

/** Deduplicate results, keeping the highest-scored entry per file+startLine */
function deduplicateResults(results: RetrievalResult[]): RetrievalResult[] {
    const seen = new Map<string, RetrievalResult>();
    for (const result of results) {
        const key = dedupKey(result.filePath, result.startLine);
        const existing = seen.get(key);
        if (!existing || result.score > existing.score) {
            seen.set(key, result);
        }
    }
    return Array.from(seen.values());
}

/**
 * Two-route retrieval with reranker fusion.
 *
 * Routes run in parallel:
 * 1. Graph traversal (structural neighbors of mentioned symbols)
 * 2. Keyword search (BM25)
 *
 * Results are deduplicated, then reranked to select top-K.
 */
export async function retrieve(config: RetrievalConfig, query: string, mentionedSymbols?: string[]): Promise<RetrievalResult[]> {
    const symbols = mentionedSymbols ?? [];

    const [graphResults, keywordResults] = await Promise.all([
        // Route 1: Graph traversal
        symbols.length > 0
            ? config.graphClient.traverseFromSymbols(symbols, config.graphHops)
            : Promise.resolve([] as GraphTraversalResult[]),

        // Route 2: Keyword search
        config.graphClient.keywordSearch(query, config.keywordTopK),
    ]);

    // Convert all routes to uniform RetrievalResult format
    const allResults: RetrievalResult[] = [
        ...graphResultsToRetrieval(graphResults),
        ...keywordResultsToRetrieval(keywordResults),
    ];

    if (allResults.length === 0) return [];

    // Deduplicate by filePath + startLine
    const deduplicated = deduplicateResults(allResults);

    // Rerank all candidates
    const documents = deduplicated.map((r) => r.content);
    const ranked = await config.reranker.rerank(query, documents);

    // Map ranked results back, taking finalTopK
    const topK = ranked.slice(0, config.finalTopK);
    return topK.map((r) => ({
        ...deduplicated[r.index],
        score: r.score,
    }));
}

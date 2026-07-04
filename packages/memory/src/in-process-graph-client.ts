/**
 * In-process GraphClient factory: wraps a `CodebaseIndexer` (from
 * `@ashara/memory-indexer`) as a `GraphClient` without any HTTP round-trip.
 */

import { CodebaseIndexer, Bm25Index } from "@ashara/memory-indexer";

import type { GraphClient, GraphTraversalResult, KeywordResult } from "./graph-client.js";

/**
 * Wrap an existing `CodebaseIndexer` as a `GraphClient` that reads its live
 * `SymbolGraph` directly. The BM25 index is memoized and rebuilt only when
 * the graph's node count changes, so repeated keyword searches against a
 * stable index are cheap.
 */
export function createInProcessGraphClient(indexer: CodebaseIndexer): GraphClient {
    let bm25Cached: Bm25Index | null = null;
    let bm25CachedNodeCount = 0;

    return {
        async traverseFromSymbols(symbolNames: string[], hops: number): Promise<GraphTraversalResult[]> {
            const graph = indexer.graph;
            if (graph.nodeCount() === 0) return [];

            const visited = new Set<string>();
            let frontier: string[] = [];
            const results: GraphTraversalResult[] = [];

            for (const name of symbolNames) {
                for (const key of graph.findSymbolsByName(name)) {
                    if (!visited.has(key)) {
                        visited.add(key);
                        frontier.push(key);
                        const sym = graph.getSymbol(key);
                        if (sym) {
                            results.push({
                                symbolName: sym.name,
                                symbolKind: sym.kind,
                                filePath: sym.filePath,
                                startLine: sym.lineRange[0],
                                endLine: sym.lineRange[1],
                                signature: sym.signature,
                                distance: 0,
                            });
                        }
                    }
                }
            }

            for (let d = 1; d <= hops; d++) {
                const next: string[] = [];
                for (const key of frontier) {
                    for (const nKey of graph.neighbors(key, "outgoing")) {
                        if (!visited.has(nKey)) {
                            visited.add(nKey);
                            next.push(nKey);
                            const sym = graph.getSymbol(nKey);
                            if (sym) {
                                results.push({
                                    symbolName: sym.name,
                                    symbolKind: sym.kind,
                                    filePath: sym.filePath,
                                    startLine: sym.lineRange[0],
                                    endLine: sym.lineRange[1],
                                    signature: sym.signature,
                                    distance: d,
                                });
                            }
                        }
                    }
                }
                frontier = next;
            }

            return results;
        },

        async keywordSearch(query: string, topK: number): Promise<KeywordResult[]> {
            const graph = indexer.graph;
            const nc = graph.nodeCount();
            if (nc === 0) return [];

            if (!bm25Cached || bm25CachedNodeCount !== nc) {
                bm25Cached = Bm25Index.fromGraph(graph);
                bm25CachedNodeCount = nc;
            }

            return bm25Cached.search(query, topK).map((sr) => {
                const sym = graph.getSymbolById(sr.id);
                return {
                    symbolName: sr.id.name,
                    symbolKind: sr.id.kind,
                    filePath: sr.id.filePath,
                    startLine: sym?.lineRange[0] ?? 0,
                    endLine: sym?.lineRange[1] ?? 0,
                    score: sr.score,
                };
            });
        },
    };
}

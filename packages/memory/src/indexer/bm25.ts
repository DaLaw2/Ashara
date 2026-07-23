// BM25 lexical search index — ported from crates/ashara-memory/src/bm25.rs

import type { SymbolGraph } from "./graph.js";
import type { SymbolId } from "./types.js";
import { symbolIdKey } from "./types.js";

const K1 = 1.2;
const B = 0.75;

const STOP_WORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
    "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
    "their", "then", "there", "these", "they", "this", "to", "was", "will", "with",
]);

interface Document {
    id: SymbolId;
    length: number;
}

export interface SearchResult {
    id: SymbolId;
    score: number;
}

export class Bm25Index {
    private inverted: Map<string, [number, number][]> = new Map();
    private documents: Document[] = [];
    private avgDocLen = 0;

    static fromGraph(graph: SymbolGraph): Bm25Index {
        const index = new Bm25Index();
        for (const symbol of graph.allSymbols()) {
            let text = symbol.name;
            if (symbol.signature) {
                text += " " + symbol.signature;
            }
            index.addDocument(symbol.id, text);
        }
        index.recomputeAvgDocLen();
        return index;
    }

    addDocument(id: SymbolId, text: string): void {
        const tokens = tokenize(text);
        const length = tokens.length;

        const termFreq = new Map<string, number>();
        for (const token of tokens) {
            termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
        }

        const docIdx = this.documents.length;

        for (const [term, freq] of termFreq) {
            let postings = this.inverted.get(term);
            if (!postings) {
                postings = [];
                this.inverted.set(term, postings);
            }
            postings.push([docIdx, freq]);
        }

        this.documents.push({ id, length });
        this.recomputeAvgDocLen();
    }

    search(query: string, topK: number): SearchResult[] {
        if (this.documents.length === 0) return [];

        const queryTerms = tokenize(query);
        if (queryTerms.length === 0) return [];

        const n = this.documents.length;
        const scores = new Map<number, number>();

        for (const term of queryTerms) {
            const postings = this.inverted.get(term);
            if (!postings) continue;

            const df = postings.length;
            const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1.0);

            for (const [docIdx, tf] of postings) {
                const doc = this.documents[docIdx];
                const dl = doc.length;

                const numerator = tf * (K1 + 1.0);
                const denominator = tf + K1 * (1.0 - B + B * dl / this.avgDocLen);
                const termScore = idf * numerator / denominator;

                scores.set(docIdx, (scores.get(docIdx) ?? 0) + termScore);
            }
        }

        const results = [...scores.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, topK)
            .map(([idx, score]) => ({ id: this.documents[idx].id, score }));

        return results;
    }

    private recomputeAvgDocLen(): void {
        if (this.documents.length === 0) {
            this.avgDocLen = 0;
        } else {
            const total = this.documents.reduce((sum, d) => sum + d.length, 0);
            this.avgDocLen = total / this.documents.length;
        }
    }
}

export function tokenize(text: string): string[] {
    return text
        .split(/[^a-zA-Z0-9]+/)
        .map((s) => s.toLowerCase())
        .filter((s) => s.length > 1 && !STOP_WORDS.has(s));
}

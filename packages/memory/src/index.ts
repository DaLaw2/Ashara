export type {
    EmbedderConfig,
    Embedder,
    EmbeddingErrorKind,
} from "./types.js";
export { EmbeddingError } from "./types.js";
export { createEmbedder, createEmbedderFromEnv } from "./embedder.js";

// Graph client (in-process query interface)
export type { GraphClient, GraphTraversalResult, KeywordResult } from "./graph-client.js";

// In-process GraphClient factory
export { createInProcessGraphClient } from "./in-process-graph-client.js";

// Two-route (graph + keyword) retrieval orchestrator
export type {
    RetrievalConfig,
    RetrievalResult,
    KnowledgeStore,
    KnowledgeResult,
    RankedResult,
    Reranker,
} from "./retrieval.js";
export { retrieve } from "./retrieval.js";

// Indexer (was @ashara/memory-indexer)
export { initParser, parseFile } from "./indexer/index.js";
export { SymbolGraph } from "./indexer/index.js";
export { Bm25Index, tokenize } from "./indexer/index.js";
export { CodebaseIndexer } from "./indexer/index.js";
export { symbolIdKey } from "./indexer/index.js";
export type {
    ParseResult,
    RefKind,
    SymbolDef,
    SymbolId,
    SymbolKind,
    SymbolRef,
    SearchResult,
} from "./indexer/index.js";

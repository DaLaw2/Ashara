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

export interface EmbedderConfig {
    readonly provider: "voyage" | "local";
    readonly model: string;
    readonly apiKey?: string;
    readonly baseUrl?: string;
    readonly dimensions: number;
    readonly batchSize: number;
}

export interface Embedder {
    embed(texts: string[]): Promise<number[][]>;
}

export type EmbeddingErrorKind = "ProviderError" | "RateLimitError" | "InvalidInputError";

export class EmbeddingError extends Error {
    readonly kind: EmbeddingErrorKind;

    constructor(kind: EmbeddingErrorKind, message: string) {
        super(message);
        this.name = "EmbeddingError";
        this.kind = kind;
    }
}

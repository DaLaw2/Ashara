import type { Embedder, EmbedderConfig } from "./types.js";
import { EmbeddingError } from "./types.js";
import { fetchWithTimeout, getEmbedTimeoutMs } from "./fetch-utils.js";
import { retryWithBackoff } from "./retry.js";

const EMBED_RETRY_OPTIONS = {
    isNonRetryable: (err: unknown) => err instanceof EmbeddingError && err.kind === "InvalidInputError",
};

interface VoyageResponse {
    data: Array<{ embedding: number[] }>;
}

interface OpenAICompatibleResponse {
    data: Array<{ embedding: number[] }>;
}

class VoyageEmbedder implements Embedder {
    private readonly apiKey: string;
    private readonly model: string;
    private readonly batchSize: number;

    constructor(config: EmbedderConfig) {
        if (!config.apiKey) {
            throw new EmbeddingError("InvalidInputError", "Voyage API key is required");
        }
        this.apiKey = config.apiKey;
        this.model = config.model;
        this.batchSize = config.batchSize;
    }

    async embed(texts: string[]): Promise<number[][]> {
        const results: number[][] = [];
        for (let i = 0; i < texts.length; i += this.batchSize) {
            const batch = texts.slice(i, i + this.batchSize);
            const batchResults = await retryWithBackoff(() => this.callApi(batch), EMBED_RETRY_OPTIONS);
            results.push(...batchResults);
        }
        return results;
    }

    private async callApi(texts: string[]): Promise<number[][]> {
        const response = await fetchWithTimeout("https://api.voyageai.com/v1/embeddings", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                input: texts,
                input_type: "document",
            }),
        }, getEmbedTimeoutMs());

        if (response.status === 429) {
            throw new EmbeddingError("RateLimitError", "Rate limit exceeded");
        }

        if (!response.ok) {
            const body = await response.text();
            throw new EmbeddingError("ProviderError", `Voyage API error ${response.status}: ${body}`);
        }

        const data = (await response.json()) as VoyageResponse;
        return data.data.map((d) => d.embedding);
    }
}

class LocalEmbedder implements Embedder {
    private readonly baseUrl: string;
    private readonly model: string;
    private readonly batchSize: number;

    constructor(config: EmbedderConfig) {
        if (!config.baseUrl) {
            throw new EmbeddingError("InvalidInputError", "Base URL is required for local embedder");
        }
        this.baseUrl = config.baseUrl.replace(/\/$/, "");
        this.model = config.model;
        this.batchSize = config.batchSize;
    }

    async embed(texts: string[]): Promise<number[][]> {
        const results: number[][] = [];
        for (let i = 0; i < texts.length; i += this.batchSize) {
            const batch = texts.slice(i, i + this.batchSize);
            const batchResults = await retryWithBackoff(() => this.callApi(batch), EMBED_RETRY_OPTIONS);
            results.push(...batchResults);
        }
        return results;
    }

    private async callApi(texts: string[]): Promise<number[][]> {
        const response = await fetchWithTimeout(`${this.baseUrl}/v1/embeddings`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: this.model,
                input: texts,
            }),
        }, getEmbedTimeoutMs());

        if (response.status === 429) {
            throw new EmbeddingError("RateLimitError", "Rate limit exceeded");
        }

        if (!response.ok) {
            const body = await response.text();
            throw new EmbeddingError("ProviderError", `Local embedder error ${response.status}: ${body}`);
        }

        const data = (await response.json()) as OpenAICompatibleResponse;
        return data.data.map((d) => d.embedding);
    }
}

export function createEmbedder(config: EmbedderConfig): Embedder {
    switch (config.provider) {
        case "voyage":
            return new VoyageEmbedder(config);
        case "local":
            return new LocalEmbedder(config);
    }
}

export function createEmbedderFromEnv(): Embedder | null {
    const voyageKey = process.env["VOYAGE_API_KEY"]?.trim();
    if (voyageKey) {
        return createEmbedder({
            provider: "voyage",
            model: process.env["VOYAGE_EMBED_MODEL"] ?? "voyage-code-3",
            apiKey: voyageKey,
            dimensions: 1024,
            batchSize: 128,
        });
    }

    const localUrl = process.env["LOCAL_EMBEDDER_URL"]?.trim();
    if (localUrl) {
        return createEmbedder({
            provider: "local",
            model: process.env["LOCAL_EMBED_MODEL"] ?? "nomic-embed-text",
            baseUrl: localUrl,
            dimensions: 768,
            batchSize: 64,
        });
    }

    return null;
}

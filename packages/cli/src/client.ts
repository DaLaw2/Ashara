// ---------------------------------------------------------------------------
// Ashara HTTP client — typed wrapper around the Rust server API
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { SessionPhase, ProjectKnowledge } from "@ashara/shared";
import { loadServerEnv } from "@ashara/shared";

// --- Error types ---

type ClientErrorKind = "network" | "server" | "parse" | "not_found";

export class ClientError extends Error {
    readonly kind: ClientErrorKind;
    readonly statusCode: number | undefined;

    constructor(kind: ClientErrorKind, message: string, statusCode?: number) {
        super(message);
        this.name = "ClientError";
        this.kind = kind;
        this.statusCode = statusCode;
    }
}

// --- Server-side types (match Rust serde output) ---

export type WorkItemLevel = "Epic" | "Story" | "Feature" | "Task";
export type WorkItemStatus = "Pending" | "InProgress" | "Completed" | "Blocked" | "Failed" | "Abandoned";

/** One node in a bulk hierarchy create. `tempId` is batch-local; `parentId` references another item's `tempId`. */
export interface BulkWorkItem {
    readonly tempId: string;
    readonly level: WorkItemLevel;
    readonly title: string;
    readonly description?: string;
    readonly parentId?: string;
    readonly taskSpec?: unknown;
    readonly northStar?: string;
}

export interface BulkCreateRequest {
    readonly items: BulkWorkItem[];
    readonly edges: Array<{ readonly from: string; readonly to: string }>;
    /**
     * The knowledge graph the decomposition that produced these items derived
     * (ADR-052). Required — the server rejects a batch without it, because it is
     * the only statement in this request of what the project is built in.
     */
    readonly knowledge: ProjectKnowledge;
}

export interface WorkItem {
    readonly id: string;
    readonly level: WorkItemLevel;
    readonly status: WorkItemStatus;
    readonly parentId: string | null;
    readonly title: string;
    readonly description: string | null;
    readonly taskSpec?: unknown;
    readonly northStar: string | null;
    readonly successCriteria?: unknown;
    readonly blockedReason?: unknown;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface SessionBrief {
    readonly goal: string;
    readonly [key: string]: unknown;
}

export interface SessionInfo {
    readonly sessionId: string;
    readonly taskId: string;
    readonly brief: SessionBrief;
    readonly phase: SessionPhase;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface CreateVisionRequest {
    readonly visionText: string;
    readonly summary: string;
    // open-by-design: user/alignment-supplied inference results, shape varies per vision
    readonly inferences?: Record<string, unknown>;
    readonly scopeBoundaries?: string[];
    readonly confirmedDirections?: Array<{
        dimension: string;
        direction: string;
        confidence: "Explicit" | "Inferred";
        source: "UserAnswer" | "SystemInference" | "AlignmentConversation";
    }>;
    readonly userAnswers?: Array<{
        question: string;
        answer: string;
        answeredAt: string;
    }>;
    readonly openQuestions?: string[];
    readonly changeReason?: string;
}

// --- Zod schemas (runtime validation for server responses) ---

const WorkItemSchema = z.object({
    id: z.string(),
    level: z.enum(["Epic", "Story", "Feature", "Task"]),
    status: z.enum(["Pending", "InProgress", "Completed", "Blocked", "Failed", "Abandoned"]),
    parentId: z.string().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    taskSpec: z.any(),
    northStar: z.string().nullable(),
    successCriteria: z.any(),
    blockedReason: z.any(),
    createdAt: z.string(),
    updatedAt: z.string(),
});

const BulkCreateResponseSchema = z.object({
    tempIdToId: z.record(z.string(), z.string()),
    created: z.number(),
});

const SessionInfoSchema = z.object({
    sessionId: z.string(),
    taskId: z.string(),
    brief: z.object({
        goal: z.string(),
    }).passthrough(),
    // Exactly the phases anything writes; `SessionInfo.phase: SessionPhase`
    // below makes a drift from the Published Language a compile error.
    phase: z.enum(["Preparing", "Completed", "Failed"]),
    createdAt: z.string(),
    updatedAt: z.string(),
});

// --- Client ---

const _serverEnv = loadServerEnv();

export class AsharaClient {
    private readonly apiToken: string | undefined;
    private readonly httpTimeoutMs: number;

    constructor(readonly baseUrl: string) {
        this.apiToken = _serverEnv.apiToken;
        this.httpTimeoutMs = _serverEnv.httpTimeoutMs;
    }

    private authHeaders(): Record<string, string> {
        if (!this.apiToken) return {};
        return { Authorization: `Bearer ${this.apiToken}` };
    }

    async createWorkItemsBulk(req: BulkCreateRequest): Promise<Record<string, string>> {
        const response = await this.post("/work-items/bulk", req);
        const parsed = BulkCreateResponseSchema.parse(await this.parseJson(response));
        return parsed.tempIdToId;
    }

    async listWorkItems(): Promise<WorkItem[]> {
        const response = await this.get("/work-items");
        return z.array(WorkItemSchema).parse(await this.parseJson(response));
    }

    async listSessions(): Promise<SessionInfo[]> {
        const response = await this.get("/sessions");
        return z.array(SessionInfoSchema).parse(await this.parseJson(response));
    }

    async createVision(req: CreateVisionRequest): Promise<void> {
        await this.post("/vision", req);
    }

    // -- internal helpers --

    private async get(path: string): Promise<Response> {
        const url = `${this.baseUrl}${path}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.httpTimeoutMs);
        let response: Response;
        try {
            response = await fetch(url, { headers: this.authHeaders(), signal: controller.signal });
        } catch (err) {
            // eslint-disable-next-line no-restricted-syntax -- lossy-extraction-ok: migration backlog
            const message = err instanceof Error ? err.message : String(err);
            throw new ClientError("network", `GET ${url} failed: ${message}`);
        } finally {
            clearTimeout(timeoutId);
        }
        this.checkStatus(response, url);
        return response;
    }

    private async post(path: string, body: unknown): Promise<Response> {
        const url = `${this.baseUrl}${path}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.httpTimeoutMs);
        let response: Response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...this.authHeaders() },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
        } catch (err) {
            // eslint-disable-next-line no-restricted-syntax -- lossy-extraction-ok: migration backlog
            const message = err instanceof Error ? err.message : String(err);
            throw new ClientError("network", `POST ${url} failed: ${message}`);
        } finally {
            clearTimeout(timeoutId);
        }
        this.checkStatus(response, url);
        return response;
    }

    private checkStatus(response: Response, url: string): void {
        if (response.status === 401) {
            throw new ClientError(
                "server",
                "Authentication failed (401). Set ASHARA_API_TOKEN in .env to match the server token.",
                401,
            );
        }
        if (response.status === 404) {
            throw new ClientError("not_found", `Not found: ${url}`, 404);
        }
        if (!response.ok) {
            throw new ClientError("server", `Server error ${response.status}: ${url}`, response.status);
        }
    }

    private async parseJson(response: Response): Promise<unknown> {
        try {
            return await response.json();
        } catch (err) {
            // eslint-disable-next-line no-restricted-syntax -- lossy-extraction-ok: migration backlog
            const message = err instanceof Error ? err.message : String(err);
            throw new ClientError("parse", `Failed to parse JSON response: ${message}`);
        }
    }
}

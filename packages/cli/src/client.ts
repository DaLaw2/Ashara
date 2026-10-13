// ---------------------------------------------------------------------------
// Ashara HTTP client — typed wrapper around the Rust server API
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { SessionPhase } from "@ashara/shared";
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

type WorkItemLevel = "Epic" | "Task";
type WorkItemStatus = "Pending" | "InProgress" | "Completed" | "Blocked" | "Failed" | "Abandoned";

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

interface SessionBrief {
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
    /** The client the project belongs to (migration 018); the server answers 404 for an unknown one. */
    readonly clientId: string;
    readonly projectName: string;
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
    level: z.enum(["Epic", "Task"]),
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

const CreateVisionResponseSchema = z.object({
    projectId: z.string().uuid(),
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

    async listWorkItems(): Promise<WorkItem[]> {
        const response = await this.get("/work-items");
        return z.array(WorkItemSchema).parse(await this.parseJson(response));
    }

    async listSessions(): Promise<SessionInfo[]> {
        const response = await this.get("/sessions");
        return z.array(SessionInfoSchema).parse(await this.parseJson(response));
    }

    /** Creates the project and its vision v1; returns the project id. */
    async createVision(req: CreateVisionRequest): Promise<string> {
        const response = await this.post("/vision", req);
        return CreateVisionResponseSchema.parse(await this.parseJson(response)).projectId;
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
            const message = err instanceof Error ? err.message : String(err);
            throw new ClientError("parse", `Failed to parse JSON response: ${message}`);
        }
    }
}

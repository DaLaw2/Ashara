// ---------------------------------------------------------------------------
// vision command — align, persist the vision, monitor; the server plans it
// ---------------------------------------------------------------------------

import { createInterface } from "node:readline";
import {
    AlignmentEngine,
    createGatewayAlignmentLLM,
    alignmentReask,
} from "@ashara/engagement";
import type { AlignmentLLM, AlignmentResult, DirectionInference, DirectionQuestion } from "@ashara/engagement";
import { LLMGateway, buildGateway, loadGatewayConfigFromApi, withStructuredLadder } from "@ashara/llm-gateway";
import type { GatewayConfig } from "@ashara/llm-gateway";
import { loadServerEnv } from "@ashara/shared";
import { AsharaClient } from "../client.js";
import { monitorProgress } from "../display.js";

// --- Error type ---

type VisionErrorKind = "empty_vision" | "llm_unavailable" | "alignment_failed" | "server_error";

export class VisionError extends Error {
    readonly kind: VisionErrorKind;

    constructor(kind: VisionErrorKind, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "VisionError";
        this.kind = kind;
    }
}

// --- LLM helper: create real LLM from gateway ---

// Alignment rides its own reliability ladder (mig4-t1): a schema-validated
// structured call, never the gateway unwrapped. Decomposition is the server's
// (t-server-decomposition-m1); the CLI only aligns.
function createLLMFromGateway(gateway: LLMGateway): AlignmentLLM {
    return createGatewayAlignmentLLM(
        withStructuredLadder(gateway, { site: "alignment", attempts: 2, reask: alignmentReask }),
    );
}

// Composition-root LLM acquisition (ADR-030). The acquired config always goes
// through buildGateway: providers configured -> real gateway; zero providers
// -> NoLLMProvidersConfigured propagates, naming the config sources checked.
/** @testseam vision.test.ts asserts the fail-closed path with no LLM configured */
export async function tryCreateLLM(): Promise<AlignmentLLM> {
    const serverUrl = process.env.ASHARA_SERVER_URL;
    const apiToken = process.env.ASHARA_API_TOKEN;

    if (!serverUrl || !apiToken) {
        throw new VisionError(
            "llm_unavailable",
            `ASHARA_SERVER_URL and ASHARA_API_TOKEN must both be set. ` +
            `The CLI loads its LLM configuration from the Ashara server; ` +
            `there is no local fallback.`,
        );
    }

    const checkedSources: string[] = [];
    let config: GatewayConfig;
    try {
        config = await loadGatewayConfigFromApi(serverUrl, apiToken);
        checkedSources.push(`API ${serverUrl}`);
        console.log(`[Vision] config loaded from API (${serverUrl})`);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new VisionError(
            "llm_unavailable",
            `Failed to load LLM config from API (${serverUrl}): ${msg}`,
            { cause: e },
        );
    }

    // Client-side calls: no database here, and alignment runs before the project
    // exists. The CLI is deleted when the web client is in use (ADR-076).
    return createLLMFromGateway(buildGateway({
        config,
        checkedSources,
        recording: {
            kind: "unrecorded",
            reason: "client-side CLI process with no database; alignment runs before the project row exists",
        },
    }));
}

// --- CLI input ---

function readLine(prompt: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

// --- Alignment display ---

interface UserAnswer {
    readonly category: string;
    readonly question: string;
    readonly answer: string;
}

function displayInferences(inferences: DirectionInference[]): void {
    if (inferences.length === 0) return;
    console.log("\n  System Understanding:");
    for (const inf of inferences) {
        const confidence = inf.confidence === "high" ? "[++]" : inf.confidence === "medium" ? "[+ ]" : "[  ]";
        const source = inf.source === "inferred" ? " (inferred)" : "";
        console.log(`    ${confidence} [${inf.category}] ${inf.inference}${source}`);
    }
}

function displayQuestions(questions: DirectionQuestion[]): void {
    if (questions.length === 0) return;
    console.log("\n  Open Questions:");
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        console.log(`\n    ${i + 1}. ${q.question}`);
        console.log(`       Why: ${q.why}`);
        if (q.options && q.options.length > 0) {
            for (let j = 0; j < q.options.length; j++) {
                console.log(`       ${j + 1}) ${q.options[j]}`);
            }
        }
    }
}

// --- Alignment helper ---

async function alignVision(visionText: string, llm: AlignmentLLM): Promise<AlignmentResult> {
    const engine = new AlignmentEngine(llm);

    try {
        return await engine.align({ description: visionText });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new VisionError("alignment_failed", `Alignment failed: ${message}`, { cause: err });
    }
}

// --- Main entry ---

/**
 * ADR-019 dual-mode selector. `noInteract` is the explicit override (`--no-interact`
 * on the CLI); when absent, `process.stdin.isTTY` remains the fallback mode
 * selector, exactly as before this flag existed. Passing `noInteract: true`
 * always forces the non-interactive, default-assumption path regardless of TTY.
 * `clientId` is the client the project is created for; it has no default.
 */
export interface RunVisionOptions {
    readonly noInteract?: boolean;
    readonly clientId: string;
}

export async function runVision(visionText: string, options: RunVisionOptions): Promise<number> {
    if (!visionText.trim()) {
        throw new VisionError("empty_vision", "Vision text must not be empty");
    }

    const { serverUrl } = loadServerEnv();
    const client = new AsharaClient(serverUrl);

    // 0. Real LLM gateway — required. tryCreateLLM throws on a missing server
    // configuration and on NoLLMProvidersConfigured: alignment requires a real
    // LLM and cannot proceed on a constant answer (Discipline A).
    const llm = await tryCreateLLM();
    console.log("[ashara] Using real LLM gateway for alignment");

    // 1. Alignment
    console.log("[ashara] Analyzing vision...");
    const alignment = await alignVision(visionText, llm);

    // 2. Display inferences and completeness
    displayInferences(alignment.inferences);
    console.log(`\n  Completeness: ${(alignment.completeness.score * 100).toFixed(0)}%`);
    if (alignment.visionSummary) {
        console.log(`  Summary: ${alignment.visionSummary}`);
    }

    // 3. Interactive Q&A -- ADR-019 dual mode. `--no-interact` forces
    // non-interactive regardless of TTY; otherwise `isTTY` is still the
    // fallback selector (unchanged from before this flag existed).
    const isInteractive = options.noInteract ? false : (process.stdin.isTTY ?? false);
    const answers: UserAnswer[] = [];

    if (alignment.questions.length > 0 && isInteractive) {
        displayQuestions(alignment.questions);
        console.log("\n  Answer each question (press Enter to skip):\n");

        for (let i = 0; i < alignment.questions.length; i++) {
            const q = alignment.questions[i];
            const answer = await readLine(`    ${i + 1}. > `);
            if (answer) {
                answers.push({ category: q.category, question: q.question, answer });
            }
        }

        if (answers.length > 0) {
            console.log(`\n[ashara] Received ${answers.length} answer(s).`);
        }
    } else if (alignment.questions.length > 0) {
        // Non-interactive: nothing answers the questions, so each one is
        // recorded as open on the vision document (openQuestions below).
        console.log(
            `[ashara] ${alignment.questions.length} question(s) unanswered (non-interactive mode) -- recorded as open questions`,
        );
    }

    // 4. Confirm before proceeding
    if (isInteractive) {
        const proceed = await readLine("\nProceed with execution? [Y/n] ");
        if (proceed.toLowerCase() === "n") {
            console.log("[ashara] Aborted by user.");
            return 1;
        }
    }

    // 5. Persist vision + alignment to server. This creates the project every
    // later request is keyed by, so a failure here stops the run.
    console.log("[ashara] Persisting vision document...");
    let projectId: string;
    try {
        const confirmedDirections = alignment.inferences.map(inf => ({
            dimension: inf.category,
            direction: inf.inference,
            confidence: (inf.confidence === "high" ? "Explicit" : "Inferred") as "Explicit" | "Inferred",
            source: (inf.source === "explicit" ? "UserAnswer" : "SystemInference") as "UserAnswer" | "SystemInference" | "AlignmentConversation",
        }));
        const userAnswers = answers.map(a => ({
            question: a.question,
            answer: a.answer,
            answeredAt: new Date().toISOString(),
        }));
        const answeredQuestions = new Set(answers.map(a => a.question));
        const openQuestions = alignment.questions
            .filter(q => !answeredQuestions.has(q.question))
            .map(q => q.question);
        // contract-erasing: keys are DirectionCategory, values are inference
        // strings — widened for createVision's untyped JSON field. A Zod schema
        // belongs here when the vision persistence endpoint gets a typed contract.
        const inferencesJson: Record<string, unknown> = {};
        for (const inf of alignment.inferences) {
            inferencesJson[inf.category] = inf.inference;
        }

        projectId = await client.createVision({
            clientId: options.clientId,
            projectName: visionText.length > 80 ? visionText.slice(0, 80) : visionText,
            visionText,
            summary: alignment.visionSummary,
            inferences: inferencesJson,
            scopeBoundaries: [],
            confirmedDirections: confirmedDirections,
            userAnswers,
            openQuestions,
        });
        console.log(`[ashara] Project ${projectId} created; vision document persisted.`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ashara] Failed to persist vision: ${message}`);
        return 1;
    }

    // 6. Planning is the server's: the vision just persisted wakes its loop,
    // which decomposes it into the first plan (t-server-decomposition-m1).
    // Decomposing here as well would write a second plan for the same project.
    console.log("[ashara] The server is planning the project from its vision.");

    // 7. Monitor progress
    console.log("[ashara] Execution started. Monitoring...\n");
    const success = await monitorProgress(client);

    return success ? 0 : 1;
}

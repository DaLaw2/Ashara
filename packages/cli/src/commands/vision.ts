// ---------------------------------------------------------------------------
// vision command — align, decompose, post work items, monitor
// ---------------------------------------------------------------------------

import { createInterface } from "node:readline";
import {
    AlignmentEngine,
    createGatewayAlignmentLLM,
    alignmentReask,
    DEFAULT_DIRECTION_ASSUMPTIONS,
} from "@ashara/engagement";
import type { AlignmentLLM, AlignmentResult, DirectionInference, DirectionQuestion } from "@ashara/engagement";
import { DecompositionEngine, resetIdCounter, createGatewayDecompositionLLM } from "@ashara/planning";
import type { DecompositionLLM, DecompositionResult, WorkItemSpec } from "@ashara/planning";
import { LLMGateway, buildGateway, loadGatewayConfigFromApi, withStructuredLadder } from "@ashara/llm-gateway";
import type { GatewayConfig } from "@ashara/llm-gateway";
import { loadServerEnv } from "@ashara/shared";
import { AsharaClient } from "../client.js";
import type { BulkWorkItem, WorkItemLevel } from "../client.js";
import { monitorProgress } from "../display.js";

// --- Error type ---

type VisionErrorKind = "empty_vision" | "llm_unavailable" | "alignment_failed" | "decomposition_failed" | "server_error";

export class VisionError extends Error {
    readonly kind: VisionErrorKind;

    constructor(kind: VisionErrorKind, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "VisionError";
        this.kind = kind;
    }
}

// --- LLM helper: create real LLM from gateway ---

function createLLMFromGateway(gateway: LLMGateway): AlignmentLLM & DecompositionLLM {
    // Both halves now ride their OWN reliability ladder (mig4-t1 for alignment,
    // mig-run10 semantic phantom-ref validation for decomposition) -- neither
    // hits the gateway unwrapped. The old free-text `generate` seam (raw
    // gateway.complete, naive colon-split parsing) is gone: alignment inference
    // is a schema-validated structured call, ladder-wrapped here exactly like
    // decomposition wraps itself internally.
    const alignmentLLM = createGatewayAlignmentLLM(
        withStructuredLadder(gateway, { site: "alignment", attempts: 2, reask: alignmentReask }),
    );
    const decompositionLLM = createGatewayDecompositionLLM(gateway);
    return {
        infer: alignmentLLM.infer,
        generateStructured: decompositionLLM.generateStructured,
    };
}

// Composition-root LLM acquisition (ADR-030). Config acquisition keeps its
// API-then-TOML fallback chain, but the *result* always goes through
// buildGateway: providers configured -> real gateway; zero providers with no
// test flag -> NoLLMProvidersConfigured propagates. Zero providers +
// ASHARA_TEST_STUB_LLM=1 is now ALSO a failure: alignment requires a real
// LLM and cannot proceed on a stub (Discipline A). The error names the
// actual cause — which config sources were checked and what each yielded —
// rather than a blanket "STUB MODE" that ends the investigation.
export async function tryCreateLLM(): Promise<AlignmentLLM & DecompositionLLM> {
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

    const result = buildGateway({ config, checkedSources });
    if (result.kind === "stub") {
        throw new VisionError(
            "llm_unavailable",
            `Alignment requires a real LLM but no providers are configured ` +
            `(checked: ${checkedSources.join(", ") || "none"}). ` +
            `ASHARA_TEST_STUB_LLM=1 permits stub mode for other subsystems, ` +
            `but alignment cannot proceed without a provider — configure at ` +
            `least one (ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, ` +
            `MISTRAL_API_KEY, XAI_API_KEY, GOOGLE_API_KEY, or LOCAL_LLM_URL).`,
        );
    }
    return createLLMFromGateway(result.gateway);
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

export interface UserAnswer {
    readonly category: string;
    readonly question: string;
    readonly answer: string;
}

/**
 * A non-interactive default-assumption record (ADR-019, T3): the CLI's
 * best-effort stand-in for a `UserAnswer` when nothing is running
 * interactively to answer `question`. Kept as a distinct type (not folded
 * into `UserAnswer`) so the enriched north star and the persisted vision
 * document can label system-picked defaults differently from what a human
 * actually confirmed -- the whole point of recording an assumption is that
 * it is honestly NOT the same thing as a user answer.
 */
export interface Assumption {
    readonly category: string;
    readonly question: string;
    readonly value: string;
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

/**
 * Picks the non-interactive default for an open question (ADR-019 T3). Prefers
 * a tentative same-category inference if one exists (the "highest-confidence
 * default" from the inference set) -- in the real `AlignmentEngine.align`
 * pipeline a question's category never has one (see `generateQuestions`'s
 * ambiguity gate: a category is only asked about when it has NO inference, or
 * is explicitly flagged ambiguous, and those two sets are schema-enforced to
 * be disjoint) -- so this falls through to the documented per-axis default in
 * practice. The inference branch is defensive, not dead: it protects a caller
 * that builds `AlignmentResult` some other way (e.g. a future dashboard flow)
 * from silently losing a real tentative guess to a generic fallback.
 */
export function pickDefaultAssumption(
    question: DirectionQuestion,
    inferences: DirectionInference[],
): string {
    const tentative = inferences.find((i) => i.category === question.category);
    return tentative?.inference ?? DEFAULT_DIRECTION_ASSUMPTIONS[question.category];
}

export function buildEnrichedNorthStar(
    visionSummary: string,
    answers: UserAnswer[],
    assumptions: Assumption[] = [],
): string {
    const sections = [visionSummary];

    if (answers.length > 0) {
        const answerContext = answers.map((a) => `${a.question} -> ${a.answer}`).join("\n");
        sections.push(`User clarifications:\n${answerContext}`);
    }

    if (assumptions.length > 0) {
        // Labeled distinctly from "User clarifications" -- these were never
        // confirmed by a human, so downstream planning prompts should read
        // them as a working default, not a settled decision.
        const assumptionContext = assumptions
            .map((a) => `${a.question} -> ${a.value} (assumed default, not confirmed by user)`)
            .join("\n");
        sections.push(`System-assumed defaults (non-interactive mode; rerun interactively to change):\n${assumptionContext}`);
    }

    if (sections.length === 1) return visionSummary;
    return sections.join("\n\n");
}

// --- Level mapping: TS decomposition levels -> Rust server levels ---

function toServerLevel(level: string): WorkItemLevel {
    switch (level) {
        case "epic":
            return "Epic";
        case "story":
            return "Story";
        case "feature":
            return "Feature";
        case "task":
            return "Task";
        default:
            throw new Error(`Unknown work item level "${level}". Valid: epic, story, feature, task`);
    }
}

// --- Alignment helper ---

export async function alignVision(visionText: string, llm: AlignmentLLM): Promise<AlignmentResult> {
    const engine = new AlignmentEngine(llm);

    try {
        return await engine.align({ description: visionText });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new VisionError("alignment_failed", `Alignment failed: ${message}`, { cause: err });
    }
}

// --- Decomposition helper ---

export async function decomposeVision(
    visionText: string,
    alignment: AlignmentResult,
    llm?: DecompositionLLM,
    answers?: UserAnswer[],
    assumptions?: Assumption[],
): Promise<DecompositionResult> {
    const engine = new DecompositionEngine(llm ?? null);

    resetIdCounter();

    const enrichedNorthStar = buildEnrichedNorthStar(alignment.visionSummary, answers ?? [], assumptions ?? []);

    const input = {
        epicTitle: visionText.length > 80 ? visionText.slice(0, 80) : visionText,
        epicNorthStar: enrichedNorthStar,
        epicDescription: visionText,
        conventions: [],
    };

    try {
        return await engine.decompose(input);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new VisionError("decomposition_failed", `Decomposition failed: ${message}`);
    }
}

// --- Post work items to server ---

async function postWorkItems(client: AsharaClient, decomposition: DecompositionResult): Promise<void> {
    // Build the whole hierarchy (epic -> stories -> features -> tasks) plus its
    // dependency edges as ONE transactional request (ADR-029). Items are ordered
    // parents-before-children and reference each other by decomposition ID
    // (batch-local tempIds); the server assigns real IDs atomically. A mid-batch
    // failure rolls the entire plan back instead of leaving a partial graph.
    const items: BulkWorkItem[] = [];

    items.push({
        tempId: decomposition.epic.id,
        level: toServerLevel(decomposition.epic.level),
        title: decomposition.epic.title,
        description: decomposition.epic.description,
        northStar: decomposition.epic.northStar,
    });

    for (const story of decomposition.stories) {
        items.push({
            tempId: story.id,
            level: toServerLevel(story.level),
            title: story.title,
            description: story.description,
            parentId: decomposition.epic.id,
            northStar: story.northStar,
        });
    }

    for (const feature of decomposition.features) {
        items.push({
            tempId: feature.id,
            level: toServerLevel(feature.level),
            title: feature.title,
            description: feature.description,
            parentId: feature.parentId,
        });
    }

    for (const task of decomposition.tasks) {
        const taskWithSpec = task as WorkItemSpec & { readonly taskSpec?: unknown };
        items.push({
            tempId: task.id,
            level: toServerLevel(task.level),
            title: task.title,
            description: task.description,
            parentId: task.parentId,
            taskSpec: taskWithSpec.taskSpec,
        });
    }

    const edges = decomposition.dependencyEdges.map((edge) => ({ from: edge.from, to: edge.to }));

    // The graph travels with the plan that produced it (ADR-052). Before this it
    // never left the CLI: the server derived a contract from task prose alone and
    // wrote an empty knowledge graph, so nothing downstream could name the stack.
    await client.createWorkItemsBulk({ items, edges, knowledge: decomposition.knowledge });
}

// --- Main entry ---

/**
 * ADR-019 dual-mode selector. `noInteract` is the explicit override (`--no-interact`
 * on the CLI); when absent, `process.stdin.isTTY` remains the fallback mode
 * selector, exactly as before this flag existed. Passing `noInteract: true`
 * always forces the non-interactive, default-assumption path regardless of TTY.
 */
export interface RunVisionOptions {
    readonly noInteract?: boolean;
}

export async function runVision(visionText: string, options: RunVisionOptions = {}): Promise<number> {
    if (!visionText.trim()) {
        throw new VisionError("empty_vision", "Vision text must not be empty");
    }

    const { serverUrl } = loadServerEnv();
    const client = new AsharaClient(serverUrl);

    // 0. Real LLM gateway — required. tryCreateLLM throws on both
    // NoLLMProvidersConfigured (no providers, no test flag) and stub mode
    // (ASHARA_TEST_STUB_LLM=1 but no providers): alignment requires a real
    // LLM and cannot proceed on a constant answer (Discipline A).
    const llm = await tryCreateLLM();
    console.log("[ashara] Using real LLM gateway for alignment and decomposition");

    // 0b. Pre-flight DeepSeek balance check (best-effort)
    if (process.env["DEEPSEEK_API_KEY"]) {
        try {
            const balanceResp = await fetch("https://api.deepseek.com/user/balance", {
                headers: { Authorization: `Bearer ${process.env["DEEPSEEK_API_KEY"]}` },
            });
            if (balanceResp.ok) {
                const data = (await balanceResp.json()) as { balance_infos?: Array<{ total_balance?: string }> };
                const balance = parseFloat(data.balance_infos?.[0]?.total_balance ?? "0");
                console.log(`[ashara] DeepSeek balance: $${balance.toFixed(2)}`);
                if (balance < 1.0) {
                    console.warn(`[ashara] WARNING: DeepSeek balance is low ($${balance.toFixed(2)})`);
                }
            }
        } catch (e: unknown) {
            console.warn(`[ashara] Failed to check DeepSeek balance: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

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
    const assumptions: Assumption[] = [];

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
        // ADR-019 non-interactive default-assumption path (T3): each open
        // question gets a recorded, Inferred-confidence assumption instead of
        // being silently discarded. It stays visible in `open_questions` too
        // (Discipline C honest residue) -- nothing here was actually
        // confirmed by a human, only tentatively resolved by the system.
        console.log(
            `[ashara] ${alignment.questions.length} question(s) unanswered (non-interactive mode) -- recording default assumptions:`,
        );
        for (const q of alignment.questions) {
            const value = pickDefaultAssumption(q, alignment.inferences);
            assumptions.push({ category: q.category, question: q.question, value });
            console.log(`    Assumed: ${value} — rerun interactively to change`);
        }
    }

    // 4. Confirm before proceeding
    if (isInteractive) {
        const proceed = await readLine("\nProceed with execution? [Y/n] ");
        if (proceed.toLowerCase() === "n") {
            console.log("[ashara] Aborted by user.");
            return 1;
        }
    }

    // 5. Persist vision + alignment to server
    console.log("[ashara] Persisting vision document...");
    try {
        const confirmedDirections = [
            ...alignment.inferences.map(inf => ({
                dimension: inf.category,
                direction: inf.inference,
                confidence: (inf.confidence === "high" ? "Explicit" : "Inferred") as "Explicit" | "Inferred",
                source: (inf.source === "explicit" ? "UserAnswer" : "SystemInference") as "UserAnswer" | "SystemInference" | "AlignmentConversation",
            })),
            // Non-interactive default assumptions (T3): always Inferred
            // confidence / SystemInference source -- distinct from both an
            // explicit vision-text signal and a real user answer, since
            // neither actually happened here.
            ...assumptions.map(a => ({
                dimension: a.category,
                direction: a.value,
                confidence: "Inferred" as const,
                source: "SystemInference" as const,
            })),
        ];
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

        await client.createVision({
            visionText,
            summary: alignment.visionSummary,
            inferences: inferencesJson,
            scopeBoundaries: [],
            confirmedDirections: confirmedDirections,
            userAnswers,
            openQuestions,
        });
        console.log("[ashara] Vision document persisted.");
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[ashara] Failed to persist vision (non-fatal): ${message}`);
    }

    // 6. Decomposition (with user answers and/or recorded assumptions)
    console.log("[ashara] Decomposing into work items...");
    const decomposition = await decomposeVision(visionText, alignment, llm, answers, assumptions);
    console.log(
        `[ashara] Created: ${decomposition.stories.length} stories, ${decomposition.tasks.length} tasks`,
    );

    // 8. Post work items to server
    console.log("[ashara] Posting work items to server...");
    try {
        await postWorkItems(client, decomposition);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ashara] Failed to post work items: ${message}`);
        return 1;
    }

    // 9. Monitor progress
    console.log("[ashara] Execution started. Monitoring...\n");
    const success = await monitorProgress(client);

    return success ? 0 : 1;
}

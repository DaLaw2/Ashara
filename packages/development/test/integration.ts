/**
 * Integration test runner — wires all TS-side components together
 * for end-to-end flow validation WITHOUT requiring PostgreSQL or Podman.
 *
 * Uses in-memory mocks for DB-dependent components (knowledge store, embedding store).
 * When useStubs=true, all LLM calls are stubbed (zero API cost).
 * When useStubs=false with an API key, uses ONLY Haiku for verification.
 */


import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AlignmentLLM, AlignmentResult as EngagementAlignmentResult } from "@ashara/engagement";
import { AlignmentEngine } from "@ashara/engagement";
import {
    BrainstormEngine,
    StubBrainstormLLM,
    DecompositionEngine,
    NorthStarChecker,
    StubNorthStarLLM,
    resetIdCounter,
} from "@ashara/planning";
import type {
    TriggerContext,
    DecompositionResult,
    TaskSpec as PlanningTaskSpec,
} from "@ashara/planning";
import type {
    RetrievalResult,
    KnowledgeStore,
    KnowledgeResult,
    GraphClient,
    GraphTraversalResult,
    KeywordResult,
} from "@ashara/memory";
import {
    LLMGateway,
    buildGatewayConfig,
} from "@ashara/llm-gateway";
import type {
    CostSummary,
} from "@ashara/llm-gateway";
import { StubDecompositionLLM } from "../../planning/src/__stubs__/decomposition-llm.js";
import { buildAutoProfile } from "../src/dispatch-utils.js";
import {
    assembleBrief,
    checkQualityGate,
} from "../src/brief-assembly.js";
import { pruneContext } from "../src/pruner.js";
import type { TaskSpec } from "../src/types.js";

/** Empty-results graph client: no backing index in this integration run */
class EmptyGraphClient implements GraphClient {
    async traverseFromSymbols(_symbolNames: string[], _hops: number): Promise<GraphTraversalResult[]> {
        return [];
    }

    async keywordSearch(_query: string, _topK: number): Promise<KeywordResult[]> {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IntegrationTestConfig {
    readonly anthropicApiKey?: string;
    readonly localLlmUrl?: string;
    readonly useStubs: boolean;
}

export interface IntegrationTestResult {
    readonly steps: StepResult[];
    readonly totalCost: number;
    readonly passed: boolean;
    readonly summary: string;
}

export interface StepResult {
    readonly step: string;
    readonly passed: boolean;
    readonly duration: number;
    readonly detail: string;
}

// ---------------------------------------------------------------------------
// In-memory knowledge store
// ---------------------------------------------------------------------------

interface InMemoryKnowledgeEntry {
    readonly id: string;
    readonly title: string;
    readonly content: string;
    readonly source: string;
    readonly tags: string[];
}

class InMemoryKnowledgeStore implements KnowledgeStore {
    private entries: InMemoryKnowledgeEntry[] = [];

    addEntry(title: string, content: string, source: string, tags: string[]): string {
        const id = crypto.randomUUID();
        this.entries.push({ id, title, content, source, tags });
        return id;
    }

    getEntries(): readonly InMemoryKnowledgeEntry[] {
        return this.entries;
    }

    async query(queryText: string, topK: number): Promise<KnowledgeResult[]> {
        const queryTerms = queryText.toLowerCase().split(/\s+/);
        const scored = this.entries.map((entry) => {
            const text = `${entry.title} ${entry.content}`.toLowerCase();
            const matches = queryTerms.filter((t) => text.includes(t)).length;
            const relevance = queryTerms.length > 0 ? matches / queryTerms.length : 0;
            return { entry, relevance };
        });

        scored.sort((a, b) => b.relevance - a.relevance);

        return scored.slice(0, topK).map((s) => ({
            filePath: s.entry.source,
            startLine: 0,
            endLine: 0,
            content: s.entry.content,
            relevance: s.relevance,
        }));
    }
}

// ---------------------------------------------------------------------------
// Session lifecycle simulation (mirrors Rust AgentSession phases)
// ---------------------------------------------------------------------------

type SessionPhase =
    | "preparing"
    | "dispatched"
    | "reasoning"
    | "building"
    | "testing"
    | "verifying"
    | "saving"
    | "completed"
    | "failed";

const PHASE_ORDER: readonly SessionPhase[] = [
    "preparing",
    "dispatched",
    "reasoning",
    "building",
    "testing",
    "verifying",
    "saving",
    "completed",
];

class SessionLifecycle {
    private phase: SessionPhase = "preparing";
    private readonly phaseDurations: Map<string, number> = new Map();
    private phaseStartTime: number = Date.now();

    currentPhase(): SessionPhase {
        return this.phase;
    }

    transition(to: SessionPhase): { ok: boolean; error?: string } {
        if (this.phase === "completed" || this.phase === "failed") {
            return { ok: false, error: `Cannot transition from terminal phase: ${this.phase}` };
        }

        if (to === "failed") {
            this.recordPhaseDuration();
            this.phase = to;
            return { ok: true };
        }

        const fromIdx = PHASE_ORDER.indexOf(this.phase);
        const toIdx = PHASE_ORDER.indexOf(to);

        if (fromIdx === -1 || toIdx === -1 || toIdx !== fromIdx + 1) {
            return { ok: false, error: `Invalid transition: ${this.phase} -> ${to}` };
        }

        this.recordPhaseDuration();
        this.phase = to;
        this.phaseStartTime = Date.now();
        return { ok: true };
    }

    getDurations(): Record<string, number> {
        return Object.fromEntries(this.phaseDurations);
    }

    private recordPhaseDuration(): void {
        const elapsed = Date.now() - this.phaseStartTime;
        this.phaseDurations.set(this.phase, elapsed);
    }
}

// ---------------------------------------------------------------------------
// Step runners
// ---------------------------------------------------------------------------

async function runStep(
    name: string,
    fn: () => Promise<string>,
): Promise<StepResult> {
    const start = Date.now();
    try {
        const detail = await fn();
        return {
            step: name,
            passed: true,
            duration: Date.now() - start,
            detail,
        };
    } catch (err) {
        return {
            step: name,
            passed: false,
            duration: Date.now() - start,
            // eslint-disable-next-line no-restricted-syntax -- lossy-extraction-ok: migration backlog
            detail: err instanceof Error ? err.message : String(err),
        };
    }
}

// ---------------------------------------------------------------------------
// Main integration test
// ---------------------------------------------------------------------------

/** @public — called by integration.test.ts */
export async function runIntegrationTest(
    config: IntegrationTestConfig,
): Promise<IntegrationTestResult> {
    const steps: StepResult[] = [];
    let totalCost = 0;

    // Reset decomposition ID counter so IDs are deterministic
    resetIdCounter();

    // Shared state across steps
    let decompositionResult: DecompositionResult | undefined;
    let taskSpec: PlanningTaskSpec | undefined;
    const knowledgeStore = new InMemoryKnowledgeStore();

    // ---- Step 1: Project Profile Detection ----
    steps.push(await runStep("Project Profile Detection", async () => {
        const projectDir = await mkdtemp(join(tmpdir(), "ashara-integration-"));
        try {
            await writeFile(join(projectDir, "Cargo.toml"), [
                '[package]',
                'name = "test-project"',
                '',
                '[dependencies]',
                'axum = "0.7"',
                'sqlx = "0.8"',
            ].join("\n"));
            await writeFile(join(projectDir, "package.json"), JSON.stringify({
                name: "test-project",
                dependencies: { typescript: "^5.0" },
                devDependencies: { "@types/bun": "^1.0" },
            }));
            await writeFile(join(projectDir, "tsconfig.json"), JSON.stringify({
                compilerOptions: { strict: true },
            }));
            await writeFile(join(projectDir, "justfile"), [
                "build:",
                "    cargo build",
                "",
                "test:",
                "    cargo test",
                "",
                "lint:",
                "    cargo clippy -- -D warnings",
            ].join("\n"));

            const profile = await buildAutoProfile(projectDir);

            const hasRust = profile.techStack.includes("Cargo.toml");
            const hasTS = profile.techStack.includes("tsconfig.json") || profile.techStack.includes("package.json");

            if (!hasRust) {
                throw new Error("Expected Cargo.toml in tech stack markers");
            }
            if (!hasTS) {
                throw new Error("Expected tsconfig.json or package.json in tech stack markers");
            }

            return `Detected: ${profile.techStack.join(", ")} | Build: ${profile.buildCommand} | Conventions: ${profile.conventions.length}`;
        } finally {
            await rm(projectDir, { recursive: true, force: true });
        }
    }));

    // ---- Step 2: Vision -> Alignment ----
    steps.push(await runStep("Vision to Alignment", async () => {
        // Hand-matched fake: these inferences match the test vision below,
        // not a hardcoded stack. If you change the vision, change these to match.
        const llm: AlignmentLLM = {
            async infer() {
                return {
                    inferences: [
                        { category: "platform", inference: "REST API", confidence: "high" },
                        { category: "persistence", inference: "PostgreSQL (relational database)", confidence: "medium" },
                    ],
                    ambiguousCategories: [],
                };
            },
        };
        const engine = new AlignmentEngine(llm);

        const result: EngagementAlignmentResult = await engine.align({
            description: "Build a REST API for task management with PostgreSQL",
        });

        if (result.inferences.length === 0) {
            throw new Error("Expected at least one inference");
        }

        const platformInference = result.inferences.find((i) => i.category === "platform");
        if (!platformInference) {
            throw new Error("Expected platform inference for REST API");
        }

        const persistenceInference = result.inferences.find((i) => i.category === "persistence");
        if (!persistenceInference) {
            throw new Error("Expected persistence inference for PostgreSQL");
        }

        const inferenceCategories = result.inferences.map((i) => i.category);
        return `Inferences: [${inferenceCategories.join(", ")}] | Score: ${result.completeness.score.toFixed(2)} | Questions: ${result.questions.length}`;
    }));

    // ---- Step 3: Epic Decomposition ----
    steps.push(await runStep("Epic Decomposition", async () => {
        const llm = new StubDecompositionLLM();
        const engine = new DecompositionEngine(llm);

        decompositionResult = await engine.decompose({
            epicTitle: "Task Management API",
            epicNorthStar: "Users can create, read, update, and delete tasks via REST API",
            epicDescription: "Build a complete REST API for task management with CRUD operations, backed by PostgreSQL",
            knowledge: {
                nodes: [
                    { id: "lang-rust", kind: "language", label: "Rust" },
                    { id: "lang-ts", kind: "language", label: "TypeScript" },
                    { id: "db", kind: "runtime", label: "PostgreSQL" },
                ],
                edges: [],
            },
            conventions: ["No unwrap without SAFETY comment", "Zero clippy warnings"],
        });

        if (!decompositionResult.epic) {
            throw new Error("Expected epic in decomposition result");
        }
        if (decompositionResult.tasks.length === 0) {
            throw new Error("Expected at least one task");
        }

        // Coarse vertical-slice strategy (granularity-debate.md): DEFAULT_DECOMPOSITION_CONFIG
        // forces maxDepth to 2, so decomposition goes straight from epic to tasks —
        // stories/features are expected to be empty, and tasks parent directly onto the epic.
        const epicId = decompositionResult.epic.id;
        const tasksWithParent = decompositionResult.tasks.filter((t) => t.parentId === epicId);

        // Grab a task spec for later steps
        taskSpec = decompositionResult.tasks[0].taskSpec;

        return [
            `Epic: ${decompositionResult.epic.title}`,
            `Stories: ${decompositionResult.stories.length}`,
            `Features: ${decompositionResult.features.length}`,
            `Tasks: ${decompositionResult.tasks.length}`,
            `Dependencies: ${decompositionResult.dependencyEdges.length}`,
            `Tasks with parent: ${tasksWithParent.length}/${decompositionResult.tasks.length}`,
        ].join(" | ");
    }));

    // ---- Step 4: Brainstorm Trigger ----
    steps.push(await runStep("Brainstorm Trigger", async () => {
        const llm = new StubBrainstormLLM();
        const engine = new BrainstormEngine(llm);

        // Scenario 1: N tasks completed — should trigger "tasks_completed"
        const triggerCtx1: TriggerContext = {
            tasksSinceBrainstorm: 5,
            hasReadyTasks: true,
            blockedTaskIds: [],
            driftDetected: false,
            recentCompletions: [
                { type: "task", id: "task-001" },
                { type: "task", id: "task-002" },
            ],
        };

        const trigger1 = engine.evaluateTrigger(triggerCtx1);
        if (!trigger1) {
            throw new Error("Expected brainstorm trigger for 5 completed tasks");
        }
        if (trigger1.reason !== "tasks_completed") {
            throw new Error(`Expected tasks_completed trigger, got ${trigger1.reason}`);
        }

        // Scenario 2: Drift detected — should trigger "direction_drift" (deep)
        const triggerCtx2: TriggerContext = {
            tasksSinceBrainstorm: 1,
            hasReadyTasks: true,
            blockedTaskIds: [],
            driftDetected: true,
            recentCompletions: [],
        };

        const trigger2 = engine.evaluateTrigger(triggerCtx2);
        if (!trigger2) {
            throw new Error("Expected brainstorm trigger for drift");
        }
        if (trigger2.level !== "deep") {
            throw new Error(`Expected deep brainstorm for drift, got ${trigger2.level}`);
        }

        // Execute the standard trigger to verify output format
        const output = await engine.execute(trigger1, "Project context here");
        if (output.recommendations.length === 0) {
            throw new Error("Expected at least one recommendation");
        }

        return `Trigger: ${trigger1.reason}/${trigger1.level} | Drift trigger: ${trigger2.reason}/${trigger2.level} | Recommendations: ${output.recommendations.length}`;
    }));

    // ---- Step 5: Codebase Indexing (simulated via stub graph client + retrieval results) ----
    steps.push(await runStep("Codebase Indexing (Simulated)", async () => {
        // Build simulated retrieval results (mirroring what the Rust-side indexer would produce)
        const stubGraphClient = new EmptyGraphClient();

        // Verify graph client returns empty results (expected for stub)
        const graphResults = await stubGraphClient.traverseFromSymbols(["AlignmentEngine"], 2);
        const keywordResults = await stubGraphClient.keywordSearch("alignment", 5);

        // Simulate BM25-style retrieval results from indexed code
        const simulatedResults: RetrievalResult[] = [
            {
                filePath: "packages/engagement/src/alignment.ts",
                startLine: 165,
                endLine: 200,
                content: [
                    "export class AlignmentEngine {",
                    "  private readonly llm: AlignmentLLM;",
                    "  private readonly config: AlignmentConfig;",
                    "  constructor(llm: AlignmentLLM, config?: Partial<AlignmentConfig>) {",
                    "    this.llm = llm;",
                    "    this.config = { ...DEFAULT_CONFIG, ...config };",
                    "  }",
                    "  async align(vision: VisionInput): Promise<AlignmentResult> { /* ... */ }",
                    "}",
                ].join("\n"),
                source: "keyword",
                score: 0.85,
            },
            {
                filePath: "packages/planning/src/decomposition.ts",
                startLine: 108,
                endLine: 150,
                content: [
                    "export class DecompositionEngine {",
                    "  private readonly llm: DecompositionLLM;",
                    "  async decompose(input: DecompositionInput): Promise<DecompositionResult> { /* ... */ }",
                    "}",
                ].join("\n"),
                source: "keyword",
                score: 0.72,
            },
            {
                filePath: "packages/development/src/brief-assembly.ts",
                startLine: 185,
                endLine: 252,
                content: [
                    "export function assembleBrief(",
                    "  taskSpec: TaskSpec,",
                    "  retrievalResults: readonly RetrievalResult[],",
                    "  projectProfile: ProjectProfile,",
                    "): Brief { /* ... */ }",
                ].join("\n"),
                source: "keyword",
                score: 0.65,
            },
        ];

        return [
            `Graph traversal: ${graphResults.length} results (stub)`,
            `Keyword search: ${keywordResults.length} results (stub)`,
            `Simulated BM25: ${simulatedResults.length} code chunks indexed`,
        ].join(" | ");
    }));

    // ---- Step 6: Brief Assembly ----
    steps.push(await runStep("Brief Assembly", async () => {
        if (!taskSpec) {
            throw new Error("No task spec from decomposition step");
        }

        // Build a TaskSpec in development format from the planning TaskSpec
        const devTaskSpec: TaskSpec = {
            goal: taskSpec.goal,
            endState: taskSpec.endState,
            scope: taskSpec.scope,
            deliverables: taskSpec.deliverables,
            checks: taskSpec.checks,
        };

        // Simulated retrieval results
        const retrievalResults: RetrievalResult[] = [
            {
                filePath: "src/api/handler.ts",
                startLine: 1,
                endLine: 30,
                content: [
                    "import { Hono } from 'hono';",
                    "const app = new Hono();",
                    "app.get('/tasks', async (c) => {",
                    "  return c.json({ tasks: [] });",
                    "});",
                ].join("\n"),
                source: "keyword",
                score: 0.8,
            },
            {
                filePath: "src/api/routes.ts",
                startLine: 1,
                endLine: 15,
                content: [
                    "export function registerRoutes(app: Hono) {",
                    "  app.get('/tasks', listTasks);",
                    "  app.post('/tasks', createTask);",
                    "}",
                ].join("\n"),
                source: "semantic",
                score: 0.7,
            },
        ];

        const projectProfile = {
            name: "test-project",
            techStack: ["Rust", "TypeScript", "PostgreSQL"],
            buildCommand: "just build",
            testCommand: "just test",
            lintCommand: "just lint",
            conventions: ["No unwrap without SAFETY comment"],
            moduleBoundaries: "",
        };

        // Set up context map
        const contextMapText = [
            "## Epic Context: epic-0001",
            "- [active_decision] API endpoint pattern: Hono handlers with typed responses",
            "- [known_constraint] Using PostgreSQL with sqlx for persistence",
        ].join("\n");

        // Knowledge context
        const knowledgeContext = "Decision: Use Hono framework for HTTP API (source: packages/development/src/index.ts)";

        const brief = assembleBrief(
            devTaskSpec,
            retrievalResults,
            projectProfile,
            { contextWindowTokens: 128_000, targetUtilization: 0.7 },
            contextMapText,
            knowledgeContext,
        );

        if (!brief.systemPrompt) {
            throw new Error("Brief missing system prompt");
        }
        if (!brief.taskSpec) {
            throw new Error("Brief missing task spec");
        }
        if (brief.totalTokens <= 0) {
            throw new Error("Brief has zero tokens");
        }

        // Quality gate
        const gate = checkQualityGate(brief, retrievalResults);

        return [
            `Tokens: ${brief.totalTokens}`,
            `Utilization: ${(brief.utilization * 100).toFixed(1)}%`,
            `Prefix: ${brief.prefixTokens}`,
            `Suffix: ${brief.suffixTokens}`,
            `Quality gate: ${gate.passed ? "PASS" : "FAIL"}`,
            `Failed checks: [${gate.failedChecks.join(", ")}]`,
        ].join(" | ");
    }));

    // ---- Step 7: LLM Verification (real API call if key provided) ----
    steps.push(await runStep("LLM Verification", async () => {
        if (config.useStubs) {
            return "SKIPPED (useStubs=true)";
        }

        const gatewayConfig = buildGatewayConfig({}, {}, []);

        if (gatewayConfig.providers.length === 0) {
            return "SKIPPED (no providers configured — set API keys or LOCAL_LLM_URL)";
        }

        const gateway = new LLMGateway(gatewayConfig);

        const response = await gateway.generateStructured({
            capability: "Light",
            prompt: "Reply with exactly: INTEGRATION_TEST_OK",
            schema: z.object({ reply: z.string() }),
            maxTokens: 50,
            temperature: 0,
        });

        const costSummary: CostSummary = gateway.getCostSummary();
        totalCost += costSummary.totalCost;

        if (!response.data.reply) {
            throw new Error("Empty response from LLM");
        }
        if (response.usage.inputTokens <= 0) {
            throw new Error("Expected non-zero input tokens");
        }

        return [
            `Response: "${response.data.reply.trim().substring(0, 40)}"`,
            `Model: ${response.model}`,
            `Input tokens: ${response.usage.inputTokens}`,
            `Output tokens: ${response.usage.outputTokens}`,
            `Cost: $${costSummary.totalCost.toFixed(6)}`,
        ].join(" | ");
    }));

    // ---- Step 8: Knowledge Store ----
    steps.push(await runStep("Knowledge Store", async () => {
        if (!decompositionResult) {
            throw new Error("No decomposition result from earlier step");
        }

        // Record a decision from the decomposition
        const decisionId = knowledgeStore.addEntry(
            "Use Hono for HTTP framework",
            "Chose Hono over Express for its lightweight design and native Bun support. " +
            "Alternatives considered: Express (heavier), Fastify (less TS-native). " +
            "Source: packages/development/src/index.ts",
            "decomposition-step-3",
            ["architecture", "framework"],
        );

        // Record a finding
        knowledgeStore.addEntry(
            "PostgreSQL connection pooling required",
            "Task management API needs connection pooling for concurrent request handling. " +
            "Source: packages/memory/src/knowledge-store.ts",
            "task-analysis",
            ["infrastructure", "database"],
        );

        // Verify retrieval
        const results = await knowledgeStore.query("HTTP framework Hono", 5);
        if (results.length === 0) {
            throw new Error("Expected knowledge store to return results");
        }

        const topResult = results[0];
        if (topResult.relevance <= 0) {
            throw new Error("Expected positive relevance score");
        }

        const allEntries = knowledgeStore.getEntries();

        return [
            `Entries stored: ${allEntries.length}`,
            `Query results: ${results.length}`,
            `Top result relevance: ${topResult.relevance.toFixed(2)}`,
            `Decision ID: ${decisionId.substring(0, 8)}...`,
        ].join(" | ");
    }));

    // ---- Step 9: Session Lifecycle ----
    steps.push(await runStep("Session Lifecycle", async () => {
        const session = new SessionLifecycle();

        if (session.currentPhase() !== "preparing") {
            throw new Error(`Expected initial phase 'preparing', got '${session.currentPhase()}'`);
        }

        // Walk through all forward phases
        const forwardPhases: SessionPhase[] = [
            "dispatched",
            "reasoning",
            "building",
            "testing",
            "verifying",
            "saving",
            "completed",
        ];

        for (const phase of forwardPhases) {
            const result = session.transition(phase);
            if (!result.ok) {
                throw new Error(`Failed to transition to ${phase}: ${result.error}`);
            }
        }

        if (session.currentPhase() !== "completed") {
            throw new Error(`Expected completed, got ${session.currentPhase()}`);
        }

        // Verify terminal phase rejects further transitions
        const failedTransition = session.transition("failed");
        if (failedTransition.ok) {
            throw new Error("Should not be able to transition from completed to failed");
        }

        // Test failure path
        const failSession = new SessionLifecycle();
        failSession.transition("dispatched");
        failSession.transition("reasoning");
        const failResult = failSession.transition("failed");
        if (!failResult.ok) {
            throw new Error("Should be able to transition to failed from reasoning");
        }
        if (failSession.currentPhase() !== "failed") {
            throw new Error(`Expected failed, got ${failSession.currentPhase()}`);
        }

        // Verify backward transition is rejected
        const backwardSession = new SessionLifecycle();
        backwardSession.transition("dispatched");
        backwardSession.transition("reasoning");
        const backwardResult = backwardSession.transition("dispatched");
        if (backwardResult.ok) {
            throw new Error("Should not allow backward transition");
        }

        const durations = session.getDurations();

        return [
            `Final phase: ${session.currentPhase()}`,
            `Phases tracked: ${Object.keys(durations).length}`,
            `Failure path: verified`,
            `Backward rejection: verified`,
        ].join(" | ");
    }));

    // ---- Step 10: Cost Summary ----
    steps.push(await runStep("Cost Summary", async () => {
        const passedSteps = steps.filter((s) => s.passed).length;
        const failedSteps = steps.filter((s) => !s.passed).length;
        const totalDuration = steps.reduce((sum, s) => sum + s.duration, 0);

        return [
            `Passed: ${passedSteps}/${steps.length}`,
            `Failed: ${failedSteps}`,
            `Total duration: ${totalDuration}ms`,
            `Total LLM cost: $${totalCost.toFixed(6)}`,
            `Mode: ${config.useStubs ? "stubs" : "real LLM"}`,
        ].join(" | ");
    }));

    // Build final result
    const allPassed = steps.every((s) => s.passed);
    const passedCount = steps.filter((s) => s.passed).length;

    return {
        steps,
        totalCost,
        passed: allPassed,
        summary: allPassed
            ? `All ${steps.length} integration steps passed (${config.useStubs ? "stub" : "real LLM"} mode, cost: $${totalCost.toFixed(6)})`
            : `${passedCount}/${steps.length} steps passed — failures: ${steps.filter((s) => !s.passed).map((s) => s.step).join(", ")}`,
    };
}

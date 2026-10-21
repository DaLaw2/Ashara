import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { KNOWN_LLM_SITES } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { parseProjectId, parseWorkItemId } from "@ashara/shared";
import { WorkBudgetSpent, WorkBudgetsInvalid } from "./errors.js";
import type { PendingLlmCall } from "./guarded-model-access.js";
import type { LlmCallRepository } from "./llm-call-repository.js";
import { SpendCap } from "./spend-cap.js";
import { projectDrawVerdict, projectWorkBudget } from "./work-ledger.js";
import { CALL_SITE_PURPOSE } from "./work-purpose.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000a1", "test");
const TASK = parseWorkItemId("00000000-0000-4000-8000-0000000000b1", "test");
const OTHER_TASK = parseWorkItemId("00000000-0000-4000-8000-0000000000b2", "test");

const MODEL: ModelConfig = {
  id: "m",
  apiModelId: "m",
  provider: "stub",
  capabilityLevel: "Strong", thinkingOffCapabilityLevel: "Strong",
  inputCostPer1M: 1,
  outputCostPer1M: 1,
  maxContextTokens: 1000,
  cacheReadCostPer1M: null,
  cacheWriteCostPer1M: null,
  priceWindows: [],
  priceTiers: [], datedPrices: [],
};

interface Row {
  readonly taskId: string | null;
  readonly callSite: string;
}

/**
 * llm_calls in memory, as the work ledger reads it: every admitted row counts as drawn, and
 * nothing a test does to it but admit and grant can change the count.
 */
function memoryLedger(granted = 0) {
  const rows: Row[] = [];
  let grants = granted;
  const ledger: Pick<LlmCallRepository, "spend" | "admit" | "work" | "workBySite"> = {
    spend: async () => ({ recordedUsd: 0, inFlightUsd: 0 }),
    admit: async (row) => {
      rows.push({ taskId: row.taskId, callSite: row.callSite });
    },
    work: async ({ taskId }): ReturnType<LlmCallRepository["work"]> => ({
      project: { spent: rows.length, inFlight: 0, granted: grants },
      task: taskId === null ? null : { spent: rows.filter((row) => row.taskId === taskId).length, inFlight: 0 },
    }),
    workBySite: async ({ taskId }) => {
      const counted = new Map<string, number>();
      for (const row of rows) if (taskId === null || row.taskId === taskId) counted.set(row.callSite, (counted.get(row.callSite) ?? 0) + 1);
      return [...counted].map(([callSite, requests]) => ({ callSite, requests })).sort((a, b) => b.requests - a.requests || a.callSite.localeCompare(b.callSite));
    },
  };
  return { ledger, rows, grant: (requests: number) => (grants += requests) };
}

function call(taskId: typeof TASK | null, callSite: PendingLlmCall["context"]["callSite"] = "agent-runner"): PendingLlmCall {
  return {
    callId: randomUUID(),
    provider: "stub",
    model: MODEL,
    operation: "generateText:turn",
    requestBytes: 10,
    maxOutputTokens: 10,
    context: { projectId: PROJECT, taskId, callSite },
    traceId: "test-trace",
  };
}

const AMPLE = { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 };

describe("the work ledger's draw", () => {
  test("a task draws until its budget is spent, then is refused at task scope with what it drew", async () => {
    const { ledger, rows } = memoryLedger();
    const cap = new SpendCap({ ledger, caps: AMPLE, workBudgets: { perTaskRequests: 2, perProjectRequests: 10, verificationReservePercent: 0 } });
    await cap.admit(call(TASK));
    await cap.admit(call(TASK, "suite-review"));
    const refused = await cap.admit(call(TASK)).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(WorkBudgetSpent);
    expect(rows).toHaveLength(2);
    expect(cap.refusalOf(refused)).toMatchObject({
      kind: "task_work",
      projectId: PROJECT,
      taskId: TASK,
      work: { scope: "task", budgetRequests: 2, spentRequests: 2, bySite: [{ callSite: "agent-runner", requests: 1 }, { callSite: "suite-review", requests: 1 }] },
    });
    // Another task of the project still draws: the budget is the task's.
    await cap.admit(call(OTHER_TASK));
    expect(rows).toHaveLength(3);
  });

  test("a task draws only what its project has left, and the project's refusal names every call site that drew it", async () => {
    const { ledger, rows } = memoryLedger();
    const cap = new SpendCap({ ledger, caps: AMPLE, workBudgets: { perTaskRequests: 50, perProjectRequests: 2, verificationReservePercent: 0 } });
    await cap.admit(call(null, "decomposition"));
    await cap.admit(call(TASK));
    const refused = await cap.admit(call(TASK)).catch((error: unknown) => error);

    expect(rows).toHaveLength(2);
    expect(cap.refusalOf(refused)).toMatchObject({ kind: "project_work", projectId: PROJECT, work: { scope: "project", budgetRequests: 2, spentRequests: 2 } });
    expect(refused).toMatchObject({ message: expect.stringContaining("Requests drawn by call site: agent-runner 1, decomposition 1.") });
  });

  test("a grant adds exactly the requests granted, and only to its project", async () => {
    const { ledger, rows, grant } = memoryLedger();
    const cap = new SpendCap({ ledger, caps: AMPLE, workBudgets: { perTaskRequests: 50, perProjectRequests: 1, verificationReservePercent: 0 } });
    await cap.admit(call(null));
    await expect(cap.admit(call(null))).rejects.toBeInstanceOf(WorkBudgetSpent);
    grant(2);
    await cap.admit(call(null));
    await cap.admit(call(null));
    const refused = await cap.admit(call(null)).catch((error: unknown) => error);
    expect(rows).toHaveLength(3);
    expect(cap.refusalOf(refused)).toMatchObject({ kind: "project_work", work: { budgetRequests: 3, grantedRequests: 2, spentRequests: 3 } });
  });
});

// A share of each project's budget only verification may draw.
describe("the verification reserve", () => {
  const budgets = { perTaskRequests: 50, perProjectRequests: 8, verificationReservePercent: 25 };

  test("refuses upstream work once only the reserve is left, naming the reserve and the call sites that drew the rest", async () => {
    const { ledger, rows } = memoryLedger();
    const cap = new SpendCap({ ledger, caps: AMPLE, workBudgets: budgets });
    for (const site of ["decomposition", "suite-review", "agent-runner", "agent-runner", "agent-runner", "agent-runner"] as const) {
      await cap.admit(call(site === "decomposition" ? null : TASK, site));
    }
    const refused = await cap.admit(call(TASK)).catch((error: unknown) => error);

    expect(rows).toHaveLength(6);
    expect(cap.refusalOf(refused)).toMatchObject({
      kind: "project_work",
      projectId: PROJECT,
      work: {
        scope: "project",
        budgetRequests: 8,
        reserveRequests: 2,
        reserveProtected: true,
        spentRequests: 6,
        bySite: [
          { callSite: "agent-runner", requests: 4 },
          { callSite: "decomposition", requests: 1 },
          { callSite: "suite-review", requests: 1 },
        ],
      },
    });
    expect(refused).toMatchObject({ message: expect.stringContaining("only its verification reserve of 2 is left, which upstream work may not draw") });
  });

  test("admits a verification request past the reserve line, and refuses it only when the whole budget is drawn", () => {
    const budget = projectWorkBudget(budgets, 0);
    expect(budget).toEqual({ budgetRequests: 8, reserveRequests: 2, upstreamRequests: 6 });
    expect(projectDrawVerdict("upstream", 5, budget)).toBe("admitted");
    expect(projectDrawVerdict("upstream", 6, budget)).toBe("reserve_protected");
    expect(projectDrawVerdict("verification", 6, budget)).toBe("admitted");
    expect(projectDrawVerdict("verification", 7, budget)).toBe("admitted");
    expect(projectDrawVerdict("verification", 8, budget)).toBe("exhausted");
    // A grant grows the reserve with the budget: the share is of the budget in force.
    expect(projectWorkBudget(budgets, 4)).toEqual({ budgetRequests: 12, reserveRequests: 3, upstreamRequests: 9 });
  });

  test("a reserve that is not a whole percent under 100 is refused at construction", () => {
    const { ledger } = memoryLedger();
    expect(() => new SpendCap({ ledger, caps: AMPLE, workBudgets: { ...budgets, verificationReservePercent: 100 } })).toThrow(WorkBudgetsInvalid);
    expect(() => new SpendCap({ ledger, caps: AMPLE, workBudgets: { ...budgets, verificationReservePercent: 2.5 } })).toThrow(WorkBudgetsInvalid);
  });

  // The classification is total over call sites: a site registered without a purpose fails here
  // (and fails to compile, CALL_SITE_PURPOSE being a Record over KnownLLMSite).
  test("classifies every registered call site, and only those", () => {
    expect(Object.keys(CALL_SITE_PURPOSE).sort()).toEqual([...KNOWN_LLM_SITES].sort());
  });
});

// The one draw point: every gateway request is admitted through SpendCap,
// whose admission draws through WorkLedger.draw, and the llm_calls row a request is counted by is
// written only there. A second writer of that row would be a request no work budget counted.
describe("the llm_calls row a request is counted by", () => {
  const SRC = join(import.meta.dirname);
  const sources = readdirSync(SRC).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

  test("is written by WorkLedger.draw alone among Finance's modules", () => {
    const writers = sources.filter((name) => /\bledger\.admit\(/.test(readFileSync(join(SRC, name), "utf8")));
    expect(writers).toEqual(["work-ledger.ts"]);
  });

  test("and the spend cap's admission reaches it", () => {
    expect(readFileSync(join(SRC, "spend-cap.ts"), "utf8")).toMatch(/await this\.work\.draw\(call, estimatedCostUsd\)/);
  });
});

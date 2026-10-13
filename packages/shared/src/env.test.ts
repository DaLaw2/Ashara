import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadBudgetEnv } from "./env.js";

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
    "ASHARA_BUDGET_TOTAL",
    "ASHARA_BUDGET_PROVIDER_ANTHROPIC",
    "ASHARA_BUDGET_PROVIDER_DEEPSEEK",
    "ASHARA_BUDGET_PROVIDER_OPENAI",
];

function saveEnv() {
    for (const key of ENV_KEYS) {
        SAVED_ENV[key] = process.env[key];
    }
}

function restoreEnv() {
    for (const key of ENV_KEYS) {
        if (SAVED_ENV[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = SAVED_ENV[key];
        }
    }
}

describe("loadBudgetEnv", () => {
    beforeEach(() => {
        saveEnv();
        for (const key of ENV_KEYS) delete process.env[key];
    });

    afterEach(() => {
        restoreEnv();
    });

    test("defaults perProvider to an empty map when no ASHARA_BUDGET_PROVIDER_* vars are set", () => {
        const budget = loadBudgetEnv();
        expect(budget.perProvider).toEqual({});
        expect(budget.total).toBe(50);
    });

    test("parses a single ASHARA_BUDGET_PROVIDER_<NAME> var, lowercasing the name", () => {
        process.env["ASHARA_BUDGET_PROVIDER_ANTHROPIC"] = "15";
        const budget = loadBudgetEnv();
        expect(budget.perProvider).toEqual({ anthropic: 15 });
    });

    test("skips a non-numeric ASHARA_BUDGET_PROVIDER_<NAME> value instead of defaulting", () => {
        process.env["ASHARA_BUDGET_PROVIDER_OPENAI"] = "not-a-number";
        const budget = loadBudgetEnv();
        expect(budget.perProvider).toEqual({});
    });
});

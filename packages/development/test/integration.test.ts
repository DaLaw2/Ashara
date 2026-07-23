/**
 * Unit tests for the integration test runner (stub path only — zero API cost).
 *
 * Validates that the full end-to-end flow completes without errors when all
 * LLM calls are stubbed, and that each integration step produces correct results.
 */

import { describe, expect, test, beforeEach } from "vitest";
import { runIntegrationTest } from "./integration.js";
import type { IntegrationTestConfig, IntegrationTestResult } from "./integration.js";

const STUB_CONFIG: IntegrationTestConfig = {
    useStubs: true,
};

describe("Integration Test (stub path)", () => {
    let result: IntegrationTestResult;

    beforeEach(async () => {
        result = await runIntegrationTest(STUB_CONFIG);
    });

    test("full flow completes without errors", () => {
        expect(result).toBeDefined();
        expect(result.steps.length).toBeGreaterThanOrEqual(10);
        expect(result.passed).toBe(true);
    });

    test("all steps pass", () => {
        const failedSteps = result.steps.filter((s) => !s.passed);
        if (failedSteps.length > 0) {
            const details = failedSteps
                .map((s) => `${s.step}: ${s.detail}`)
                .join("\n");
            throw new Error(`Failed steps:\n${details}`);
        }
        expect(failedSteps).toHaveLength(0);
    });

    test("project profile detects project markers", () => {
        const step = result.steps.find((s) => s.step === "Project Profile Detection");
        expect(step).toBeDefined();
        expect(step!.passed).toBe(true);
        expect(step!.detail).toContain("Cargo.toml");
    });

    test("vision produces alignment result with inferences", () => {
        const step = result.steps.find((s) => s.step === "Vision to Alignment");
        expect(step).toBeDefined();
        expect(step!.passed).toBe(true);
        expect(step!.detail).toContain("Inferences:");
        expect(step!.detail).toContain("platform");
        expect(step!.detail).toContain("persistence");
    });

    test("decomposition produces hierarchy", () => {
        const step = result.steps.find((s) => s.step === "Epic Decomposition");
        expect(step).toBeDefined();
        expect(step!.passed).toBe(true);
        expect(step!.detail).toContain("Epic:");
        expect(step!.detail).toContain("Stories:");
        expect(step!.detail).toContain("Features:");
        expect(step!.detail).toContain("Tasks:");
    });

    test("brainstorm trigger evaluates correctly", () => {
        const step = result.steps.find((s) => s.step === "Brainstorm Trigger");
        expect(step).toBeDefined();
        expect(step!.passed).toBe(true);
        expect(step!.detail).toContain("tasks_completed");
        expect(step!.detail).toContain("direction_drift");
    });

    test("brief assembly produces valid brief", () => {
        const step = result.steps.find((s) => s.step === "Brief Assembly");
        expect(step).toBeDefined();
        expect(step!.passed).toBe(true);
        expect(step!.detail).toContain("Tokens:");
        expect(step!.detail).toContain("Utilization:");
    });

    test("knowledge store records and retrieves entries", () => {
        const step = result.steps.find((s) => s.step === "Knowledge Store");
        expect(step).toBeDefined();
        expect(step!.passed).toBe(true);
        expect(step!.detail).toContain("Entries stored: 2");
    });

    test("session lifecycle completes", () => {
        const step = result.steps.find((s) => s.step === "Session Lifecycle");
        expect(step).toBeDefined();
        expect(step!.passed).toBe(true);
        expect(step!.detail).toContain("completed");
        expect(step!.detail).toContain("Failure path: verified");
        expect(step!.detail).toContain("Backward rejection: verified");
    });

    test("LLM verification is skipped in stub mode", () => {
        const step = result.steps.find((s) => s.step === "LLM Verification");
        expect(step).toBeDefined();
        expect(step!.passed).toBe(true);
        expect(step!.detail).toContain("SKIPPED");
    });

    test("total cost is zero in stub mode", () => {
        expect(result.totalCost).toBe(0);
    });
});

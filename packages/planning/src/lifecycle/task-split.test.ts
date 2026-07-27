import { describe, expect, test } from "vitest";
import { shouldSplit } from "./task-split.js";

describe("shouldSplit", () => {
    const noSpec = { taskSpec: undefined };
    const withSpec = (splitDepth?: number) => ({
        taskSpec: splitDepth !== undefined ? { splitDepth } : {},
    });

    test("triggers on turn_limit with files changed (the Run 41 regression)", () => {
        // This is the exact scenario that silently broke when
        // output.files_changed was removed: the agent hit the turn limit
        // while making progress (files > 0), which means the task is
        // structurally too big — split it, don't retry it identically.
        expect(shouldSplit("turn_limit", 5, noSpec)).toBe(true);
        expect(shouldSplit("turn_limit", 1, noSpec)).toBe(true);
    });

    test("does NOT trigger on turn_limit with zero files (agent made no progress)", () => {
        // Zero files = agent was stuck, not too-big. Retrying or replanning
        // is the right action; splitting would just make two stuck tasks.
        expect(shouldSplit("turn_limit", 0, noSpec)).toBe(false);
    });

    test("does NOT trigger on non-turn-limit finish reasons", () => {
        expect(shouldSplit("completed", 5, noSpec)).toBe(false);
        expect(shouldSplit("error", 5, noSpec)).toBe(false);
        expect(shouldSplit("unknown", 5, noSpec)).toBe(false);
    });

    test("does NOT trigger on already-split tasks (prevents recursive splitting)", () => {
        expect(shouldSplit("turn_limit", 5, withSpec(1))).toBe(false);
        expect(shouldSplit("turn_limit", 5, withSpec(2))).toBe(false);
    });

    test("triggers when taskSpec exists but has no splitDepth", () => {
        expect(shouldSplit("turn_limit", 3, withSpec())).toBe(true);
    });

    test("triggers when taskSpec is undefined (no spec at all)", () => {
        expect(shouldSplit("turn_limit", 3, noSpec)).toBe(true);
    });
});

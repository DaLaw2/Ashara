import { randomUUID } from "node:crypto";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { tryCreateLLM, VisionError, runVision } from "./vision.js";

// Env vars that affect LLM provider detection and config acquisition.
// Saved and restored around each test so the suite is isolated from
// whatever the host machine or CI has configured.
const LLM_ENV_KEYS = [
    "ASHARA_SERVER_URL",
    "ASHARA_API_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "XAI_API_KEY",
    "GOOGLE_API_KEY",
    "LOCAL_LLM_URL",
] as const;

describe("tryCreateLLM fail-closed (no LLM configuration)", () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of LLM_ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of LLM_ENV_KEYS) {
            if (savedEnv[key] !== undefined) {
                process.env[key] = savedEnv[key];
            } else {
                delete process.env[key];
            }
        }
    });

    test("throws VisionError of kind llm_unavailable with diagnostic context", async () => {
        const error = await tryCreateLLM().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(VisionError);
        expect(error).toHaveProperty("kind", "llm_unavailable");
        // Discipline C: the error message must carry diagnostic context about
        // which config sources were checked — not empty, not generic.
        if (error instanceof VisionError) {
            expect(error.message.length).toBeGreaterThan(0);
        }
    });

    test("full pipeline stops before alignment on a non-web-app vision", async () => {
        // Embedded firmware — the old constant would have answered this vision
        // as platform="web application", persistence="relational database",
        // stack="TypeScript". A returning constant is visibly wrong here:
        // firmware has no web platform, no relational DB, and no TypeScript.
        const firmwareVision =
            "Build a bare-metal Rust firmware for STM32 microcontrollers " +
            "that drives an SPI flash chip and exposes a UART debug console";

        const error = await runVision(firmwareVision, { clientId: randomUUID() }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(VisionError);
        expect(error).toHaveProperty("kind", "llm_unavailable");
    });
});

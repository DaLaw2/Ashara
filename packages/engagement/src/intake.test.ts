import { describe, expect, test, vi } from "vitest";
import type { ContextualLlm } from "@ashara/llm-gateway";
import { parseProjectId } from "@ashara/shared";
import { TenderIntake } from "./intake.js";
import type { IntakeStore } from "./intake.js";

describe("TenderIntake failure accounting", () => {
  test("a thrown circular non-Error is still counted as a failed attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const circular: Record<string, unknown> = { reason: "provider exploded" };
    circular["self"] = circular;
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async () => {
          throw circular;
        },
      }),
    };
    const recorded: string[] = [];
    const tender = {
      id: "tender-1",
      projectId: parseProjectId("00000000-0000-4000-8000-000000000001"),
      body: "A booking page.",
      intakeAttempts: 0,
      intakeLastError: null,
    };
    const store: IntakeStore = {
      openTenders: async () => [tender],
      currentVisionVersion: async () => null,
      recordIntake: async () => {
        throw new Error("recordIntake must not be reached");
      },
      consumeTender: async () => {},
      recordFailedAttempt: async (_tenderId, error) => {
        recorded.push(error);
        return recorded.length;
      },
      closeFailedTender: async () => {},
    };

    const [outcome] = await new TenderIntake({ llm, store }).runPending();

    expect(outcome?.kind).toBe("failed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatch(/non-Error thrown: Object \(not serializable: .*circular/i);
  });
});

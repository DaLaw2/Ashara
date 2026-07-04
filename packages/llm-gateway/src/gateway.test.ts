import { describe, expect, test } from "vitest";
import { LLMGateway } from "./gateway.js";
import type { GatewayConfig } from "./types.js";

describe("LLMGateway", () => {
  test("refuses to start without providers — fails closed instead of silently succeeding (Discipline A)", async () => {
    const config: GatewayConfig = { providers: [], defaultProvider: "none" };
    const gateway = new LLMGateway(config);

    await expect(
      gateway.complete({
        capability: "Strong",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow(/No provider available/);
  });
});

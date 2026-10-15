import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { InvalidRoutingProfiles, ModelsConfigUnreadable } from "./errors.js";
import { loadRoutingProfilesFromToml } from "./routing-profiles.js";

function writeToml(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "ashara-routing-")), "models.toml");
  writeFileSync(path, body, "utf-8");
  return path;
}

describe("loadRoutingProfilesFromToml", () => {
  test("rejects a site key outside KNOWN_LLM_SITES instead of dropping the block", () => {
    const path = writeToml(
      `[routing.profiles."deepseek"]\n"decomposition" = "deepseek-v4-flash"\n"judge:frontier" = "claude-opus-4-8"\n`,
    );

    try {
      loadRoutingProfilesFromToml(path);
      expect.unreachable("expected InvalidRoutingProfiles");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidRoutingProfiles);
      const typed = err as InvalidRoutingProfiles;
      expect(typed.configPath).toBe(path);
      expect(typed.message).toContain("judge:frontier");
      expect(typed.message).not.toContain("decomposition\" is not");
    }
  });

  test("parses partial and empty profiles, leaving completeness to buildGateway", () => {
    const path = writeToml(
      `[routing.profiles."deepseek"]\n\n[routing.profiles."anthropic+deepseek"]\n"escalation" = "claude-sonnet-4-6"\n`,
    );

    expect(loadRoutingProfilesFromToml(path)).toEqual({
      deepseek: {},
      "anthropic+deepseek": { escalation: "claude-sonnet-4-6" },
    });
  });

  test("a file with no [routing.profiles] block is no profiles; an absent or non-TOML file is refused", () => {
    expect(loadRoutingProfilesFromToml(writeToml(`[thinking]\ndefault = "off"\n`))).toEqual({});
    expect(() => loadRoutingProfilesFromToml(join(tmpdir(), "ashara-absent-models.toml"))).toThrow(ModelsConfigUnreadable);
    expect(() => loadRoutingProfilesFromToml(writeToml("not = [toml"))).toThrow(ModelsConfigUnreadable);
  });
});

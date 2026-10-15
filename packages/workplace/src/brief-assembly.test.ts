import { describe, expect, test } from "vitest";
import { formatAcceptanceCriteria } from "./brief-assembly.js";

// ---------------------------------------------------------------------------
// formatAcceptanceCriteria: successCriteria reach the brief through their own
// section, distinct from the check runner's Verification Checks.
// ---------------------------------------------------------------------------

describe("formatAcceptanceCriteria", () => {
  test("renders criteria as a bulleted list under its own heading", () => {
    const result = formatAcceptanceCriteria([
      "API returns 200 with valid JSON",
      "Error responses follow standard format",
      "Invalid input returns 400",
    ]);

    expect(result).toBe(
      "## Acceptance Criteria\n" +
      "- API returns 200 with valid JSON\n" +
      "- Error responses follow standard format\n" +
      "- Invalid input returns 400",
    );
  });

  test("returns empty string when criteria list is empty", () => {
    expect(formatAcceptanceCriteria([])).toBe("");
  });

  test("renders a single criterion without fabricating extras", () => {
    const result = formatAcceptanceCriteria(["tests pass"]);
    expect(result).toBe("## Acceptance Criteria\n- tests pass");
  });
});

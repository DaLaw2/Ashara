import { describe, it, expect } from "vitest";

describe("CI probe", () => {
  it("deliberately fails to test CI test gate", () => {
    expect(1 + 1).toBe(3);
  });
});

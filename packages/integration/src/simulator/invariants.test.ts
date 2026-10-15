import { describe, expect, it } from "vitest";
import { cellRoleViolations } from "./invariants.js";

const OWNER = "0ed5677b-4330-4dec-be2e-586c7d953682";
const OTHER = "3ee4bc78-d595-4ff8-991f-4b0aed2c67c3";
const items = [
  { id: "env", title: "Define the environment", workKind: "environment", ownerRoleId: OWNER },
  { id: "impl", title: "Deliver b1", workKind: "implementation", ownerRoleId: OWNER },
];
const cell = (task: string, role: string): { labels: Record<string, string> } => ({ labels: { "ashara.task": task, "ashara.role": role } });

describe("I3's cell clause", () => {
  it("takes the owner's cell and Z0's verifier and CI cells (seed 272: a post-merge verifier cell is no role violation)", () => {
    expect(cellRoleViolations(items, [cell("impl", OWNER), cell("impl", "verifier"), cell("impl", "ci"), cell("env", "environment-check")])).toEqual([]);
  });

  it("names a cell of another roster role, an unknown role, and a Z0 role outside its work kind", () => {
    const found = cellRoleViolations(items, [cell("impl", OTHER), cell("impl", "reviewer"), cell("impl", "environment-check"), { labels: { "ashara.task": "env" } }]);
    expect(found.map((violation) => violation.key)).toEqual([
      `cell-role:Deliver b1:${OTHER}`,
      "cell-role:Deliver b1:reviewer",
      "cell-role:Deliver b1:environment-check",
      "cell-role:Define the environment:none",
    ]);
  });
});

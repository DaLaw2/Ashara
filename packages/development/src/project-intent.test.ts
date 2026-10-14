import { describe, expect, test } from "vitest";
import { createWorkItemId } from "@ashara/shared";
import { ProjectIntentUnavailable, loadProjectIntent } from "./project-intent.js";

const taskId = createWorkItemId();
const source = (vision: { version: number; visionText: string; inferences: unknown } | null) => ({ loadIntent: async () => vision });

describe("the brief's project intent is the current vision's text and its assumptions", () => {
  test("every keyed assumption, with its status, standing and kind, of the current version", async () => {
    const inferences = [
      { key: "A1", statement: "Amounts are in one currency.", rationale: "the sample", status: "Inferred", kind: "client-visible", disclosed: "reported" },
      { key: "A2", statement: "Dates are ISO 8601.", rationale: "client answer", status: "Stated", kind: "client-visible", disclosed: "asked" },
      { key: "A3", statement: "The log is kept in one file.", rationale: "simplest", status: "Inferred", kind: "internal-design", disclosed: "reported" },
      { key: "A4", statement: "Written before kinds.", rationale: "legacy", status: "Inferred" },
    ];
    expect(await loadProjectIntent(source({ version: 3, visionText: "  An expense report tool.\n", inferences }), taskId)).toEqual({
      intent: "An expense report tool.",
      visionVersion: 3,
      assumptions: [
        { key: "A1", status: "Inferred", statement: "Amounts are in one currency.", standing: "reported", kind: "client-visible" },
        { key: "A2", status: "Stated", statement: "Dates are ISO 8601.", standing: "stated", kind: "client-visible" },
        { key: "A3", status: "Inferred", statement: "The log is kept in one file.", standing: "reported", kind: "internal-design" },
        { key: "A4", status: "Inferred", statement: "Written before kinds.", standing: "not-shown", kind: "unclassified" },
      ],
    });
  });

  test.each([
    { case: "no vision", vision: null },
    { case: "a blank vision text", vision: { version: 1, visionText: "  ", inferences: [] } },
    { case: "the keyless map shape", vision: { version: 1, visionText: "x", inferences: { stack: "Go" } } },
    { case: "an assumption without a key", vision: { version: 1, visionText: "x", inferences: [{ statement: "s", status: "Inferred" }] } },
  ])("$case: ProjectIntentUnavailable, never a brief without the assumptions", async ({ vision }) => {
    await expect(loadProjectIntent(source(vision), taskId)).rejects.toBeInstanceOf(ProjectIntentUnavailable);
  });
});

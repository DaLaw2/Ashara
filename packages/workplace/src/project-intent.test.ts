import { describe, expect, test } from "vitest";
import { createWorkItemId } from "@ashara/shared";
import { ProjectIntentUnavailable, loadProjectIntent } from "./project-intent.js";
import type { ProjectIntentSource } from "./project-intent.js";

const taskId = createWorkItemId();
const assumptions = [{ key: "A1", statement: "Amounts are in one currency.", note: "Inferred; reported to the client; client-visible behaviour" }];
const source = (vision: { version: number; visionText: string } | null): ProjectIntentSource => ({
  loadIntent: async () => (vision === null ? null : { ...vision, assumptions }),
});

describe("the brief's project intent is the current vision's text and its assumptions", () => {
  test("the text trimmed, the version, and every assumption as Delivery rendered it", async () => {
    expect(await loadProjectIntent(source({ version: 3, visionText: "  An expense report tool.\n" }), taskId)).toEqual({
      intent: "An expense report tool.",
      visionVersion: 3,
      assumptions,
    });
  });

  test.each([
    { case: "no vision", intentSource: source(null) },
    { case: "a blank vision text", intentSource: source({ version: 1, visionText: "  " }) },
    {
      case: "a vision the source cannot render",
      intentSource: {
        loadIntent: async () => {
          throw new Error("vision v1: inferences are not in a readable shape");
        },
      },
    },
  ])("$case: ProjectIntentUnavailable, never a brief without the assumptions", async ({ intentSource }) => {
    await expect(loadProjectIntent(intentSource, taskId)).rejects.toBeInstanceOf(ProjectIntentUnavailable);
  });
});

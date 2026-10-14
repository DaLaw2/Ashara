import { describe, expect, it } from "vitest";
import { renderKnowledgeContext } from "./knowledge-writer.js";

describe("renderKnowledgeContext", () => {
  it("renders every entry with no cut marker when all fit", () => {
    const text = renderKnowledgeContext([{ heading: "## A", entries: ["- one", "- two"] }]);
    expect(text).toBe("# Prior Knowledge\n\n## A\n- one\n- two");
  });

  it("is empty when no section has an entry", () => {
    expect(renderKnowledgeContext([{ heading: "## A", entries: [] }])).toBe("");
  });

  it("announces how many entries a cut omitted, in every section it reached", () => {
    const entry = "x".repeat(20);
    // Only entries count against the budget: 40 holds two 20-character entries.
    const text = renderKnowledgeContext(
      [
        { heading: "## Findings", entries: [entry, entry, entry] },
        { heading: "## Failed", entries: [entry, entry] },
      ],
      40,
    );
    expect(text).toBe(
      [
        "# Prior Knowledge",
        "",
        `## Findings\n${entry}\n${entry}\n[cut by Ashara: 1 of 3 entries omitted: the entries shown here are limited to 40 characters together]`,
        "",
        "## Failed\n[cut by Ashara: 2 of 2 entries omitted: the entries shown here are limited to 40 characters together]",
      ].join("\n"),
    );
  });
});

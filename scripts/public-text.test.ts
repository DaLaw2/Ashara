import { execFileSync } from "node:child_process";
import fs from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { extractCommentLines } from "./check-comments.js";

// Text a reader of the public repository sees outside comments (strings, test titles, lint
// messages, CI steps) names no private record: the records it would point at are not published.
// Comments are the comment lint's to hold.

const PRIVATE_POINTER = /ADR-\d{3}|owner \d{4}-\d{2}-\d{2}|CLAUDE\.md/g;

// The records checker and the comment lint's own fixtures exist to hold these pointers.
const FIXTURE_FILES = (relPath: string): boolean =>
  relPath.startsWith("scripts/check-docs") || relPath === "scripts/check-comments.test.ts";

function isScript(relPath: string): boolean {
  return /\.(?:ts|mjs)$/.test(relPath);
}

/** Every comment's [start, end) offsets in a script, test titles not included. */
function scriptCommentRanges(relPath: string, content: string): Array<readonly [number, number]> {
  const kind = relPath.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, kind);
  const ranges = new Map<number, number>();
  const collect = (found: readonly ts.CommentRange[] | undefined): void => {
    for (const range of found ?? []) ranges.set(range.pos, range.end);
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(content, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(content, node.getEnd()));
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return [...ranges.entries()];
}

/** The lines of a hash-commented file with the comment cut off, numbered from 1. */
function hashCodeLines(relPath: string, content: string): Array<{ line: number; text: string }> {
  const comments = new Map(extractCommentLines(relPath, content).map((c) => [c.line, c.text]));
  return content.split(/\r?\n/).map((text, index) => {
    const comment = comments.get(index + 1);
    return { line: index + 1, text: comment === undefined ? text : text.slice(0, text.length - comment.length) };
  });
}

function pointersOutsideComments(relPath: string, content: string): string[] {
  const hits: string[] = [];
  if (isScript(relPath)) {
    const ranges = scriptCommentRanges(relPath, content);
    for (const match of content.matchAll(PRIVATE_POINTER)) {
      const at = match.index;
      if (ranges.some(([start, end]) => at >= start && at < end)) continue;
      hits.push(`${relPath}:${content.slice(0, at).split("\n").length}: ${match[0]}`);
    }
    return hits;
  }
  for (const { line, text } of hashCodeLines(relPath, content)) {
    for (const match of text.matchAll(PRIVATE_POINTER)) hits.push(`${relPath}:${line}: ${match[0]}`);
  }
  return hits;
}

function trackedPublicText(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--", "*.ts", "*.mjs", "*.yml", "*.toml", "config/env.example"], {
    encoding: "utf8",
  });
  return listed.split("\0").filter((p) => p !== "" && !FIXTURE_FILES(p) && fs.existsSync(p));
}

// The fixtures are assembled from parts so this file holds no literal pointer for the scan to find.
const record = (n: number): string => `${"ADR"}-${String(n).padStart(3, "0")}`;
const ownerDate = `${"owner"} 2026-01-01`;
const instructionFile = `${"CLAUDE"}.md`;

describe("tracked text outside comments", () => {
  test("names no decision record id, owner decision date or agent instruction file", () => {
    const files = trackedPublicText();
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((relPath) => pointersOutsideComments(relPath, fs.readFileSync(relPath, "utf8")));
    expect(hits).toEqual([]);
  });

  test("the search reads strings and test titles, and skips comments", () => {
    const script = [
      `// ${record(1)} in a line comment`,
      `/* ${ownerDate} in a block comment */`,
      `const reason = "see ${record(2)}";`,
      `it("follows ${instructionFile}", () => {});`,
    ].join("\n");
    expect(pointersOutsideComments("x.ts", script)).toEqual([`x.ts:3: ${record(2)}`, `x.ts:4: ${instructionFile}`]);
    const toml = `# ${record(3)} in a comment\nkey = "${record(4)}" # ${record(5)}\n`;
    expect(pointersOutsideComments("x.toml", toml)).toEqual([`x.toml:2: ${record(4)}`]);
  });
});

const stepSchema = z.object({ name: z.string().optional(), env: z.record(z.string(), z.unknown()).optional(), run: z.string().optional() });
const workflowSchema = z.object({
  jobs: z.object({
    check: z.object({ steps: z.array(stepSchema).min(1) }),
    "ci-result": z.object({ needs: z.array(z.string()) }),
  }),
});
const workflow = workflowSchema.parse(parse(fs.readFileSync(".github/workflows/ci.yml", "utf8")));

describe("ci.yml", () => {
  test("the required status waits on the secret scan, the gate and every shard", () => {
    expect(workflow.jobs["ci-result"].needs).toEqual(["secret-scan", "check", "test"]);
  });

  test("just comes from a pinned release archive whose SHA-256 is checked before it runs", () => {
    const install = workflow.jobs.check.steps.find((step) => step.name === "Install just");
    expect(install?.run).toBeDefined();
    expect(install?.run).not.toMatch(/\|\s*(?:ba)?sh\b/);
    expect(install?.run).toContain("sha256sum --check");
    expect(install?.env?.["JUST_VERSION"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(install?.env?.["JUST_SHA256"]).toMatch(/^[0-9a-f]{64}$/);
  });
});

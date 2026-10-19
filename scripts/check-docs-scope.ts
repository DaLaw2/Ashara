// The doc gate's verify-block scan scope, in its own module of node built-ins only so that
// worktree-setup, which runs before a worktree has node_modules, links exactly the records the gate
// scans.

import path from "node:path";

interface ScanSource {
  /** The token SCAN_SCOPE_CLAUSE names this source by */
  readonly readmeName: string;
  /** Repo-relative file, or directory whose top-level *.md files are scanned */
  readonly rel: string;
  readonly kind: "file" | "markdown-dir";
}

/**
 * The verify-block scan scope of SCAN_SCOPE_CLAUSE. investigations/ and archive/ are dated
 * observations that never hold verify blocks, so they are not in it.
 * @testseam check-docs.test.ts requires these to be exactly the clause's tokens
 */
export const SCAN_SOURCES: readonly ScanSource[] = [
  { readmeName: "`CLAUDE.md`", rel: "CLAUDE.md", kind: "file" },
  { readmeName: "`.claude/commands/*.md`", rel: path.join(".claude", "commands"), kind: "markdown-dir" },
  { readmeName: "`docs/*.md`", rel: "docs", kind: "markdown-dir" },
  { readmeName: "`docs/design/*.md`", rel: path.join("docs", "design"), kind: "markdown-dir" },
  { readmeName: "`docs/decisions/*.md`", rel: path.join("docs", "decisions"), kind: "markdown-dir" },
  { readmeName: "`docs/rules/*.md`", rel: path.join("docs", "rules"), kind: "markdown-dir" },
];

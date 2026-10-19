import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  COMMENT_LINT_EXCLUDES,
  definedLabels,
  extractCommentLines,
  findStaleComments,
  isExcluded,
  trackedSqlNames,
} from "./check-comments.js";

const NO_LABELS: ReadonlySet<string> = new Set();

// Spelled in pieces so this file never holds a numbered migration reference as source text.
const MIGRATION = "migration";

function classesIn(file: string, content: string, labels: ReadonlySet<string> = NO_LABELS): string[] {
  return findStaleComments(file, content, labels).map((finding) => finding.patternClass);
}

// One planted comment per pattern class; each must be named by exactly its class.
const PLANTED: readonly (readonly [string, string])[] = [
  ["decision record id", "// The guard holds (ADR-074)."],
  ["decision number", "// The guard holds (d89)."],
  ["decision number", "// The guard holds, as addendum 2 says."],
  ["board id", "// The guard holds (t-comment-lint)."],
  ["board id", "// The guard holds (story s-loop-never-stop-m1)."],
  ["board id", "// The guard holds (kl-t2)."],
  ["design label", "// The halt is Delivery's (O3 c)."],
  ["design label", "// Quality's verdict on it (G4)."],
  ["design label", "// These requeues have no counter (loop L6)."],
  ["design label", "// Work items wait on no person (W12)."],
  ["design label", "// The window guard (X1)."],
  ["design label", "// The observation C2 asks for."],
  ["design label", "// Two admissions race the spend cap (F11)."],
  ["design label", "// Ranked per task (Q3b)."],
  ["design label", "// Input over the window (m3-scope C5)."],
  ["design label", "// Bounds (design P3)."],
  ["design label", "// Bounds (design §4.14)."],
  ["design label", "// Rewritten in mig-phase two."],
  ["design label", "// The epic scope (r9f-scope)."],
  ["migration number", `// The column is nullable (${MIGRATION} 048).`],
  ["migration number", "// The CHECK in 046_dev_session_attempt_evidence.sql admits these."],
  ["migration number", `// Rows written by ${MIGRATION}s 063, 069.`],
  ["migration number", `// A row written before ${MIGRATION} 058.`],
  ["migration number", "// A row that failed before 058 holds no verdict."],
  ["migration number", "// Retryable and pre-046 rows are replanned."],
  ["migration number", "// The migrated catalog (021, 026, 047)."],
  ["date", "// Measured on 2026-10-14."],
  ["governance path", "// See docs/rules/records.md."],
  ["run name", "// The m25final5 product fails here."],
  ["commit hash", "// The hardening of 31aefa1d added a query."],
  ["history marker", "// This previously threw."],
  ["history marker", "// The status was changed to Blocked by hand."],
];

describe("each planted stale comment fails with its class", () => {
  for (const [patternClass, comment] of PLANTED) {
    test(`${patternClass}: ${comment}`, () => {
      expect(classesIn("packages/x/src/a.ts", `${comment}\nexport const a = 1;\n`)).toEqual([patternClass]);
    });
  }
});

describe("clean samples pass", () => {
  const clean: readonly (readonly [string, string])[] = [
    ["a rule-stating comment", "// A refused call halts the project, so no step continues past a spent cap.\nexport const a = 1;\n"],
    ["a rule name", "// Discipline A: fail closed. Discipline D holds the old path deleted.\nexport const a = 1;\n"],
    ["a date literal in code", 'export const at = new Date("2026-10-14T10:00:00Z");\n'],
    ["a string literal holding a governance path", 'export const readme = "docs/README.md"; // the scan root\n'],
    ["numbers with no leading zero", "// Before 100 ms, after 3 tries, until 250 rows (500 at most), pre-1990, (0.05 s).\nexport const a = 1;\n"],
    ["a semver version", "// Pinned to 7.0.2 and 6.0.3; the adapter needs node 22.\nexport const a = 1;\n"],
    ["the word docs without a slash", "// The docs say nothing here; read the code.\nexport const a = 1;\n"],
    ["a hex literal in code", "export const digest = 0xdeadbeef01; // a fixed digest\n"],
    ["a comment marker inside a string", 'export const url = "http://host/ADR-074 // d89";\n'],
    ["a regular expression literal", "export const re = /\\/\\/ ADR-074/;\n"],
    ["plain words that look like labels", "// A Z0 cell, a sha256 digest, UTF8 text, an E2E run and an es2022 target.\nexport const a = 1;\n"],
    ["legitimate state words", "// A client that is no longer live is ignored; the key used to sign it is kept.\nexport const a = 1;\n"],
  ];
  for (const [name, content] of clean) {
    test(name, () => {
      expect(classesIn("packages/x/src/a.ts", content)).toEqual([]);
    });
  }
});

describe("test titles are read as comments", () => {
  test("an it, test or describe title with a stale id fails; one without passes", () => {
    const content = [
      `describe("the halt (${MIGRATION} 048)", () => {`,
      '  it.each([1])("case %s (d89)", () => {});',
      '  test.skipIf(true)("a refused call halts the project", () => {});',
      '  expect("ADR-074").toBe("ADR-074");',
      "});",
    ].join("\n");
    const found = findStaleComments("packages/x/src/a.test.ts", content, NO_LABELS);
    expect(found.map((f) => [f.line, f.patternClass])).toEqual([
      [1, "migration number"],
      [2, "decision number"],
    ]);
  });
});

describe("a label the code defines as a string passes", () => {
  test("a label held as a whole string literal anywhere is code vocabulary, and only that label", () => {
    const labels = definedLabels("packages/x/src/ids.ts", 'export const IDS = ["W1", "W2"] as const;\nexport const key = "W3:x";\n');
    expect([...labels].sort()).toEqual(["W1", "W2"]);
    expect(classesIn("packages/x/src/b.ts", "// W1 and W2 judge a busy loop.\n", labels)).toEqual([]);
    expect(classesIn("packages/x/src/b.ts", "// W3 judges a busy loop.\n", labels)).toEqual(["design label"]);
  });
});

describe("non-script files", () => {
  test("hash comments in justfile, toml, workflow and docker files are read; quoted hashes are not", () => {
    for (const file of ["justfile", "config/models.toml", ".github/workflows/ci.yml", "docker/postgres.yml"]) {
      expect(classesIn(file, '# Measured on 2026-10-14.\nkey = "#ADR-074" # the rule\n')).toEqual(["date"]);
    }
  });

  test("Markdown prose is read and fenced code is not", () => {
    const content = "The rule (ADR-074).\n\n```\ngrep ADR-074 docs/x.md\n```\n<!-- d89 -->\n";
    const found = findStaleComments("README.md", content, NO_LABELS);
    expect(found.map((f) => [f.line, f.patternClass])).toEqual([
      [1, "decision record id"],
      [6, "decision number"],
    ]);
  });

  test("a bare migration number in a config/models.toml comment fails", () => {
    expect(classesIn("config/models.toml", '# Prices refreshed before 047.\nkey = "(047)"\n')).toEqual(["migration number"]);
  });

  test("SQL comments are read and other files are not", () => {
    expect(classesIn("seed/x.sql", `SELECT 1; -- added by ${MIGRATION} 048\n`)).toEqual(["migration number"]);
    expect(extractCommentLines("package.json", '{"note": "ADR-074"}')).toEqual([]);
  });
});

describe("the exclude list", () => {
  test("a path under an excluded prefix is skipped; others are not, and no prefix is excluded now", () => {
    expect(COMMENT_LINT_EXCLUDES).toEqual([]);
    expect(isExcluded("vendor/x/a.sql", ["vendor/"])).toBe(true);
    expect(isExcluded("packages/db/src/migrations.ts", ["vendor/"])).toBe(false);
  });
});

describe("a numbered SQL file a comment names", () => {
  test("passes when a tracked file has that name, and fails when none does", () => {
    const names = trackedSqlNames(["db/000_init.sql", "packages/db/src/migrations.ts"]);
    expect([...names]).toEqual(["000_init.sql"]);
    expect(classesIn("packages/x/src/a.ts", "// Built from 000_init.sql alone.\n", names)).toEqual([]);
    expect(classesIn("packages/x/src/a.ts", "// Built from 048_no_item_waits.sql.\n", names)).toEqual([
      "migration number",
    ]);
  });
});

describe("the script over a repository", () => {
  let root = "";
  afterEach(() => {
    if (root !== "") fs.rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function repoWith(files: Readonly<Record<string, string>>): void {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ashara-comment-lint-"));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["add", "-A"], { cwd: root });
  }

  function lint(): { status: number | null; stderr: string } {
    const repo = path.join(import.meta.dirname, "..");
    const tsx = path.join(repo, "node_modules", "tsx", "dist", "cli.mjs");
    const script = path.join(repo, "scripts", "check-comments.ts");
    const run = spawnSync(process.execPath, [tsx, script], { cwd: root, encoding: "utf8", timeout: 60_000 });
    return { status: run.status, stderr: run.stderr };
  }

  test("a tracked stale comment fails naming file, line and class; a tracked SQL file may be named", () => {
    repoWith({
      "src/a.ts": "export const a = 1;\n// The halt is Delivery's (O3 c).\n// Built from 000_init.sql.\n",
      "db/000_init.sql": "-- The schema.\n",
    });
    const run = lint();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('src/a.ts:2: design label "O3 c"');
    expect(run.stderr).not.toContain("src/a.ts:3");
  });

  test("a clean repository passes", () => {
    repoWith({ "src/a.ts": "// The halt is Delivery's.\nexport const a = 1;\n" });
    expect(lint().status).toBe(0);
  });
});

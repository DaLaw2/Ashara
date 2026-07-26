import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CodebaseIndexer, describeIndexShortfall } from "./indexer.js";
import { canParse, initParser, parseFile, parserCoverage, UnsupportedLanguage } from "./parser.js";

let root: string;

function write(relativePath: string, content: string): void {
  const full = join(root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

beforeAll(async () => {
  await initParser();
  root = mkdtempSync(join(tmpdir(), "ashara-index-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parser capability is derived, not declared by callers", () => {
  it("reports the extensions its loaded grammars cover", () => {
    const coverage = parserCoverage();
    expect(coverage.initialized).toBe(true);
    expect(coverage.extensions).toContain("rs");
    expect(coverage.extensions).toContain("ts");
    // The shortfall this fix makes visible: Ashara targets any language, the
    // parser has extractors for two. If a grammar is ever added, this changes.
    expect(coverage.extensions).not.toContain("go");
  });

  it("refuses a file no grammar covers instead of returning an empty parse", () => {
    expect(canParse("cmd/jot.go")).toBe(false);
    expect(() => parseFile("cmd/jot.go", "package main")).toThrow(UnsupportedLanguage);
  });
});

describe("indexDirectory", () => {
  it("indexes a Rust project the old caller-supplied extension list never asked for", () => {
    const dir = join(root, "rust-project");
    write("rust-project/src/lib.rs", "pub struct Note { pub title: String }\npub fn add_note() {}\n");
    write("rust-project/src/main.rs", "fn main() {}\n");
    write("rust-project/Cargo.toml", "[package]\nname = \"jot\"\n");

    const indexer = new CodebaseIndexer();
    const coverage = indexer.indexDirectory(dir);

    expect(coverage.filesIndexed).toBe(2);
    expect(describeIndexShortfall(coverage, dir)).toBeNull();
    expect(indexer.graph.findSymbolsByName("Note").length).toBeGreaterThan(0);
    expect(indexer.graph.findSymbolsByName("add_note").length).toBeGreaterThan(0);
  });

  it("makes a project with no grammar visibly uncovered rather than silently empty", () => {
    const dir = join(root, "go-project");
    write("go-project/cmd/jot.go", "package main\n\nfunc main() {}\n");
    write("go-project/go.mod", "module jot\n");

    const indexer = new CodebaseIndexer();
    const coverage = indexer.indexDirectory(dir);

    expect(coverage.filesIndexed).toBe(0);
    expect(coverage.filesSeen).toBe(2);
    expect(coverage.unparsable).toContainEqual({ extension: "go", fileCount: 1 });

    const shortfall = describeIndexShortfall(coverage, dir);
    expect(shortfall).toContain("covers 0 of 2 files");
    expect(shortfall).toContain(".go");
  });

  it("reports an unreadable file instead of swallowing it", () => {
    const dir = join(root, "broken-project");
    write("broken-project/ok.rs", "pub fn ok() {}\n");
    write("broken-project/locked.rs", "pub fn locked() {}\n");
    chmodSync(join(dir, "locked.rs"), 0o000);

    const indexer = new CodebaseIndexer();
    const coverage = indexer.indexDirectory(dir);

    expect(coverage.filesIndexed).toBe(1);
    expect(coverage.failures).toHaveLength(1);
    expect(coverage.failures[0].filePath).toContain("locked.rs");
    expect(coverage.failures[0].reason).toContain("read failed");
  });

  it("distinguishes an empty tree from an uncovered one", () => {
    const dir = join(root, "empty-project");
    mkdirSync(dir, { recursive: true });

    const coverage = new CodebaseIndexer().indexDirectory(dir);

    expect(coverage.filesSeen).toBe(0);
    expect(describeIndexShortfall(coverage, dir)).toBeNull();
  });
});

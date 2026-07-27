// Codebase indexer — ported from crates/ashara-memory/src/indexer.rs
// Orchestrates tree-sitter parsing, symbol extraction, and graph construction.

import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { extname, join } from "path";
import { SymbolGraph } from "./graph.js";
import { canParse, parseFile, parserCoverage } from "./parser.js";
import type { GrammarUnavailable } from "./parser.js";
import type { ParseResult, SymbolDef, SymbolId } from "./types.js";
import { symbolIdKey } from "./types.js";

interface FileIndex {
    contentHash: string;
    parseResult: ParseResult;
}

/** Files the walk saw but no loaded grammar covers, grouped by extension. */
export interface UnparsableGroup {
    readonly extension: string;
    readonly fileCount: number;
}

export interface IndexFailure {
    readonly filePath: string;
    readonly reason: string;
}

/**
 * What an {@link CodebaseIndexer.indexDirectory} pass actually covered.
 *
 * The count alone cannot distinguish "this project has no code" from "this
 * project's language has no grammar" — both are zero, and zero read as success
 * for an entire E2E run (Run 39: a Go CLI built with no code context at all,
 * against a stated epic criterion that retrieval delivers context to agents).
 * So the pass reports what it saw, not only what it kept.
 */
export interface IndexCoverage {
    readonly filesSeen: number;
    readonly filesIndexed: number;
    readonly parsableExtensions: readonly string[];
    readonly unparsable: readonly UnparsableGroup[];
    readonly failures: readonly IndexFailure[];
    readonly unavailableGrammars: readonly GrammarUnavailable[];
    readonly parserInitialized: boolean;
}

/**
 * One sentence naming the shortfall, or null when coverage is healthy. Callers
 * log this so a project the indexer cannot read never looks like one it read.
 */
export function describeIndexShortfall(coverage: IndexCoverage, dir: string): string | null {
    if (!coverage.parserInitialized) {
        return `retrieval index for ${dir} is EMPTY: the tree-sitter parser was never initialized, so no file could be read`;
    }
    if (coverage.filesSeen === 0) return null;
    if (coverage.filesIndexed > 0) return null;

    const top = coverage.unparsable
        .slice(0, 5)
        .map((g) => `${g.extension === "" ? "(no extension)" : `.${g.extension}`} x${g.fileCount}`)
        .join(", ");
    const missing = coverage.unavailableGrammars.length > 0
        ? ` Grammars declared but not loadable: ${coverage.unavailableGrammars.map((g) => g.id).join(", ")}.`
        : "";
    return (
        `retrieval index for ${dir} covers 0 of ${coverage.filesSeen} files: no loaded grammar parses this project ` +
        `(saw ${top}; grammars cover ${coverage.parsableExtensions.map((e) => `.${e}`).join(", ") || "nothing"}).${missing} ` +
        `Briefs for this project will carry no retrieved code context.`
    );
}

export class CodebaseIndexer {
    private files: Map<string, FileIndex> = new Map();
    private _graph: SymbolGraph = new SymbolGraph();

    get graph(): SymbolGraph {
        return this._graph;
    }

    getSymbol(id: SymbolId): SymbolDef | undefined {
        return this._graph.getSymbolById(id);
    }

    indexContent(filePath: string, content: string): boolean {
        const changed = this.updateFileIndex(filePath, content);
        if (changed) {
            this.rebuildGraph();
        }
        return changed;
    }

    indexFile(filePath: string): boolean {
        const content = readFileSync(filePath, "utf-8");
        return this.indexContent(filePath, content);
    }

    /**
     * Indexes every file under `dir` that the parser reports it can parse. The
     * file set is DERIVED from the loaded grammars (`canParse`), never supplied
     * by the caller: a caller-supplied extension list cannot be checked against
     * the grammars that actually loaded, so it drifts silently.
     */
    indexDirectory(dir: string): IndexCoverage {
        const { parsable, unparsable } = this.collectFiles(dir);
        const failures: IndexFailure[] = [];
        let filesIndexed = 0;

        for (const entryPath of parsable) {
            let content: string;
            try {
                content = readFileSync(entryPath, "utf-8");
            } catch (e) {
                failures.push({ filePath: entryPath, reason: `read failed: ${describeError(e)}` });
                continue;
            }
            try {
                if (this.updateFileIndex(entryPath, content)) filesIndexed++;
            } catch (e) {
                failures.push({ filePath: entryPath, reason: `parse failed: ${describeError(e)}` });
            }
        }

        if (filesIndexed > 0) {
            this.rebuildGraph();
        }

        const parser = parserCoverage();
        const coverage: IndexCoverage = {
            filesSeen: parsable.length + unparsable.reduce((sum, g) => sum + g.fileCount, 0),
            filesIndexed,
            parsableExtensions: parser.extensions,
            unparsable,
            failures,
            unavailableGrammars: parser.unavailable,
            parserInitialized: parser.initialized,
        };

        // Discipline C: a per-file failure that only lives in a return value is
        // one `void` call away from being silent again.
        if (failures.length > 0) {
            console.warn(
                `[indexer] ${failures.length}/${parsable.length} parsable files failed under ${dir}: ` +
                    failures.slice(0, 3).map((f) => `${f.filePath} (${f.reason})`).join("; "),
            );
        }

        return coverage;
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    private updateFileIndex(filePath: string, content: string): boolean {
        const hash = createHash("sha256").update(content).digest("hex");

        const existing = this.files.get(filePath);
        if (existing && existing.contentHash === hash) {
            return false;
        }

        const parseResult = parseFile(filePath, content);

        this.files.set(filePath, {
            contentHash: hash,
            parseResult,
        });
        return true;
    }

    private rebuildGraph(): void {
        this._graph.clear();

        // Phase 1: add all symbols as nodes
        for (const fileIndex of this.files.values()) {
            for (const symbol of fileIndex.parseResult.symbols) {
                this._graph.addSymbol(symbol);
            }
        }

        // Phase 2: queue all references
        for (const fileIndex of this.files.values()) {
            for (const reference of fileIndex.parseResult.references) {
                this._graph.addReference(reference);
            }
        }

        // Phase 3: resolve references into graph edges
        this._graph.resolveReferences();
    }

    private collectFiles(dir: string): { parsable: string[]; unparsable: UnparsableGroup[] } {
        const parsable: string[] = [];
        const unparsableByExt = new Map<string, number>();
        this.walkDir(dir, parsable, unparsableByExt);
        return {
            parsable,
            unparsable: [...unparsableByExt.entries()]
                .map(([extension, fileCount]) => ({ extension, fileCount }))
                .sort((a, b) => b.fileCount - a.fileCount),
        };
    }

    private walkDir(dir: string, parsable: string[], unparsableByExt: Map<string, number>): void {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                // Skip hidden directories and common non-source directories
                if (
                    !entry.name.startsWith(".") &&
                    entry.name !== "node_modules" &&
                    entry.name !== "target"
                ) {
                    this.walkDir(fullPath, parsable, unparsableByExt);
                }
            } else if (canParse(fullPath)) {
                parsable.push(fullPath);
            } else {
                // Counted, not discarded: the files a project is MADE of when none
                // of them are parsable is the only evidence that coverage is zero
                // by shortfall rather than by an empty tree.
                const extension = extname(entry.name).slice(1).toLowerCase();
                unparsableByExt.set(extension, (unparsableByExt.get(extension) ?? 0) + 1);
            }
        }
    }
}

function describeError(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

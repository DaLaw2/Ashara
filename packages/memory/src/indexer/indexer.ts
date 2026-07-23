// Codebase indexer — ported from crates/ashara-memory/src/indexer.rs
// Orchestrates tree-sitter parsing, symbol extraction, and graph construction.

import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { extname, join } from "path";

import { SymbolGraph } from "./graph.js";
import { parseFile } from "./parser.js";
import type { ParseResult, SymbolDef, SymbolId } from "./types.js";
import { symbolIdKey } from "./types.js";

interface FileIndex {
    contentHash: string;
    parseResult: ParseResult;
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

    indexDirectory(dir: string, extensions: string[]): number {
        const entries = this.collectFiles(dir, extensions);
        let count = 0;
        for (const entryPath of entries) {
            try {
                const content = readFileSync(entryPath, "utf-8");
                try {
                    if (this.updateFileIndex(entryPath, content)) {
                        count++;
                    }
                } catch {
                    // Failed to parse file, skip
                }
            } catch {
                // Failed to read file, skip
            }
        }
        if (count > 0) {
            this.rebuildGraph();
        }
        return count;
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

    private collectFiles(dir: string, extensions: string[]): string[] {
        const files: string[] = [];
        this.walkDir(dir, extensions, files);
        return files;
    }

    private walkDir(dir: string, extensions: string[], files: string[]): void {
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
                    this.walkDir(fullPath, extensions, files);
                }
            } else {
                const ext = extname(entry.name).slice(1); // remove leading dot
                if (extensions.includes(ext)) {
                    files.push(fullPath);
                }
            }
        }
    }
}

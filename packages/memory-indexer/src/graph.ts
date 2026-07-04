// Directed symbol dependency graph — ported from crates/ashara-memory/src/graph.rs
// Replaces petgraph with adjacency lists.

import type { RefKind, SymbolDef, SymbolId, SymbolKind, SymbolRef } from "./types.js";
import { symbolIdKey } from "./types.js";

export class SymbolGraph {
    private nodes: Map<string, SymbolDef> = new Map();
    private edges: Map<string, Set<string>> = new Map();
    private reverseEdges: Map<string, Set<string>> = new Map();
    private nameIndex: Map<string, string[]> = new Map();
    private unresolvedRefs: SymbolRef[] = [];

    addSymbol(def: SymbolDef): void {
        const key = symbolIdKey(def.id);
        if (this.nodes.has(key)) return;

        this.nodes.set(key, def);
        this.edges.set(key, new Set());
        this.reverseEdges.set(key, new Set());

        const existing = this.nameIndex.get(def.id.name);
        if (existing) {
            existing.push(key);
        } else {
            this.nameIndex.set(def.id.name, [key]);
        }
    }

    addReference(ref: SymbolRef): void {
        this.unresolvedRefs.push(ref);
    }

    resolveReferences(): void {
        const refs = this.unresolvedRefs;
        this.unresolvedRefs = [];

        for (const ref of refs) {
            this.tryResolveReference(ref);
        }
    }

    private tryResolveReference(ref: SymbolRef): boolean {
        const fromKey = symbolIdKey(ref.fromSymbol);
        if (!this.nodes.has(fromKey)) return false;

        const toKey = this.findSymbolKeyByName(ref.toName, ref.refKind);
        if (!toKey) return false;

        // Avoid self-edges
        if (fromKey === toKey) return false;

        this.edges.get(fromKey)?.add(toKey);
        this.reverseEdges.get(toKey)?.add(fromKey);
        return true;
    }

    private findSymbolKeyByName(name: string, refKind: RefKind): string | undefined {
        const candidates = this.nameIndex.get(name);
        if (!candidates || candidates.length === 0) return undefined;

        if (candidates.length === 1) return candidates[0];

        // Multiple candidates — prefer the kind that matches the reference semantics
        let preferred: SymbolKind[];
        switch (refKind) {
            case "Call":
                preferred = ["Function"];
                break;
            case "TypeRef":
                preferred = ["Struct", "Enum", "Trait", "Interface", "Class", "Type"];
                break;
            case "Impl":
                preferred = ["Trait"];
                break;
            case "Use":
            case "Import":
                preferred = [];
                break;
        }

        for (const key of candidates) {
            const sym = this.nodes.get(key);
            if (sym && preferred.includes(sym.kind)) {
                return key;
            }
        }

        return candidates[0];
    }

    getSymbol(key: string): SymbolDef | undefined {
        return this.nodes.get(key);
    }

    getSymbolById(id: SymbolId): SymbolDef | undefined {
        return this.nodes.get(symbolIdKey(id));
    }

    neighbors(key: string, direction: "outgoing" | "incoming"): string[] {
        const edgeMap = direction === "outgoing" ? this.edges : this.reverseEdges;
        const set = edgeMap.get(key);
        return set ? [...set] : [];
    }

    getDependencies(id: SymbolId): SymbolDef[] {
        const key = symbolIdKey(id);
        return this.neighbors(key, "outgoing")
            .map((k) => this.nodes.get(k))
            .filter((s): s is SymbolDef => s !== undefined);
    }

    getDependents(id: SymbolId): SymbolDef[] {
        const key = symbolIdKey(id);
        return this.neighbors(key, "incoming")
            .map((k) => this.nodes.get(k))
            .filter((s): s is SymbolDef => s !== undefined);
    }

    allSymbols(): SymbolDef[] {
        return [...this.nodes.values()];
    }

    allKeys(): string[] {
        return [...this.nodes.keys()];
    }

    findSymbolsByName(name: string): string[] {
        return this.nameIndex.get(name) ?? [];
    }

    nodeCount(): number {
        return this.nodes.size;
    }

    edgeCount(): number {
        let count = 0;
        for (const set of this.edges.values()) {
            count += set.size;
        }
        return count;
    }

    outDegree(key: string): number {
        return this.edges.get(key)?.size ?? 0;
    }

    clear(): void {
        this.nodes.clear();
        this.edges.clear();
        this.reverseEdges.clear();
        this.nameIndex.clear();
        this.unresolvedRefs = [];
    }
}

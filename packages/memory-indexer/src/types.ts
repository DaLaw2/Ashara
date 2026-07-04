// Symbol types for the memory indexer — ported from crates/ashara-memory/src/symbol.rs

export type SymbolKind =
    | "Function"
    | "Struct"
    | "Enum"
    | "Trait"
    | "Impl"
    | "Const"
    | "Type"
    | "Module"
    | "Interface"
    | "Class";

export type RefKind = "Call" | "Use" | "Impl" | "TypeRef" | "Import";

export interface SymbolId {
    filePath: string;
    name: string;
    kind: SymbolKind;
}

export interface SymbolDef {
    id: SymbolId;
    name: string;
    kind: SymbolKind;
    filePath: string;
    byteRange: [number, number];
    lineRange: [number, number];
    signature?: string;
}

export interface SymbolRef {
    fromSymbol: SymbolId;
    toName: string;
    refKind: RefKind;
    filePath: string;
    byteRange: [number, number];
}

export interface ParseResult {
    symbols: SymbolDef[];
    references: SymbolRef[];
}

export function symbolIdKey(id: SymbolId): string {
    return `${id.filePath}::${id.name}::${id.kind}`;
}

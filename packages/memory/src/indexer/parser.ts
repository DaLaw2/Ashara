// Tree-sitter based parser — ported from crates/ashara-memory/src/parser.rs
// Uses web-tree-sitter (WASM) for Bun compatibility.

import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Node as TSNode, Parser } from "web-tree-sitter";
import type { ParseResult, RefKind, SymbolDef, SymbolId, SymbolKind, SymbolRef } from "./types.js";

// Resolved through the package name, not a hardcoded node_modules path: the
// grammar files must be found wherever the installer placed the package.
const WASM_DIR = dirname(fileURLToPath(import.meta.resolve("tree-sitter-wasms/out/tree-sitter-rust.wasm")));

/**
 * A grammar this parser can actually extract symbols from: a loadable WASM
 * grammar PLUS an extractor that knows its node types. Both halves are required
 * — tree-sitter-wasms ships far more grammars than there are extractors here,
 * and a grammar without an extractor produces no symbols, so it is not listed.
 *
 * This table is the ONLY place in Ashara that names a file extension. Callers
 * ask {@link canParse} instead of restating it; see {@link parserCoverage} for
 * the shortfall that table-driven honesty makes visible.
 */
interface GrammarSpec {
    readonly id: string;
    readonly wasmFile: string;
    readonly extensions: readonly string[];
    readonly extract: (filePath: string, content: string, language: Language) => ParseResult;
}

const GRAMMARS: readonly GrammarSpec[] = [
    { id: "rust", wasmFile: "tree-sitter-rust.wasm", extensions: ["rs"], extract: parseRust },
    { id: "typescript", wasmFile: "tree-sitter-typescript.wasm", extensions: ["ts", "tsx"], extract: parseTypescript },
];

export interface GrammarUnavailable {
    readonly id: string;
    readonly reason: string;
}

/** What the parser can parse right now, and what it declared but could not load. */
export interface ParserCoverage {
    readonly initialized: boolean;
    readonly extensions: readonly string[];
    readonly unavailable: readonly GrammarUnavailable[];
}

/** Thrown when {@link parseFile} is handed a file no loaded grammar covers. */
export class UnsupportedLanguage extends Error {
    constructor(
        readonly filePath: string,
        readonly extension: string,
        readonly supportedExtensions: readonly string[],
    ) {
        super(
            `no loaded tree-sitter grammar parses "${extension === "" ? "(no extension)" : `.${extension}`}" ` +
                `(file: ${filePath}); loaded grammars cover: ${supportedExtensions.map((e) => `.${e}`).join(", ") || "nothing"}`,
        );
        this.name = "UnsupportedLanguage";
    }
}

/** Thrown when NO declared grammar loaded — indexing anything would be a lie. */
export class ParserUnavailable extends Error {
    constructor(readonly unavailable: readonly GrammarUnavailable[]) {
        super(
            `tree-sitter parser unusable: none of ${unavailable.length} declared grammars loaded ` +
                `(${unavailable.map((g) => `${g.id}: ${g.reason}`).join("; ")})`,
        );
        this.name = "ParserUnavailable";
    }
}

let initialized = false;
const byExtension = new Map<string, { spec: GrammarSpec; language: Language }>();
const unavailable: GrammarUnavailable[] = [];

export async function initParser(): Promise<void> {
    if (initialized) return;
    await Parser.init();

    unavailable.length = 0;
    for (const spec of GRAMMARS) {
        try {
            const language = await Language.load(resolve(WASM_DIR, spec.wasmFile));
            for (const extension of spec.extensions) byExtension.set(extension, { spec, language });
        } catch (e) {
            // Per-grammar, not all-or-nothing: one missing WASM file degrades
            // coverage, and the degradation is reported rather than pretended away.
            // eslint-disable-next-line no-restricted-syntax -- lossy-extraction-ok: migration backlog
            unavailable.push({ id: spec.id, reason: e instanceof Error ? e.message : String(e) });
        }
    }

    if (byExtension.size === 0) throw new ParserUnavailable(unavailable);
    initialized = true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function extensionOf(filePath: string): string {
    return extname(filePath).slice(1).toLowerCase();
}

/**
 * The parser's own file→grammar decision. Callers derive their file set from
 * this rather than carrying an extension list of their own — the list a caller
 * writes down always drifts from the grammars that actually loaded, and the
 * drift is silent (Run 39: the indexer asked for js/jsx/json, none of which any
 * loaded grammar parses, and indexed zero files without saying so).
 */
export function canParse(filePath: string): boolean {
    return byExtension.has(extensionOf(filePath));
}

export function parserCoverage(): ParserCoverage {
    return {
        initialized,
        extensions: [...byExtension.keys()].sort(),
        unavailable: [...unavailable],
    };
}

export function parseFile(filePath: string, content: string): ParseResult {
    const extension = extensionOf(filePath);
    const entry = byExtension.get(extension);
    if (!entry) throw new UnsupportedLanguage(filePath, extension, [...byExtension.keys()].sort());
    return entry.spec.extract(filePath, content, entry.language);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function nodeText(node: TSNode, source: string): string {
    return source.slice(node.startIndex, node.endIndex);
}

function extractSignature(node: TSNode, source: string): string | undefined {
    const body = node.childForFieldName("body");
    const sigEnd = body ? body.startIndex : node.endIndex;
    const sig = source.slice(node.startIndex, sigEnd).trim();
    return sig.length > 0 ? sig : undefined;
}

function makeSymbolDef(
    filePath: string,
    source: string,
    node: TSNode,
    name: string,
    kind: SymbolKind,
): SymbolDef {
    return {
        id: { filePath, name, kind },
        name,
        kind,
        filePath,
        byteRange: [node.startIndex, node.endIndex],
        lineRange: [node.startPosition.row, node.endPosition.row + 1],
        signature: extractSignature(node, source),
    };
}

function makeModuleSymbol(filePath: string, source: string): SymbolDef {
    const parts = filePath.split("/");
    const fileName = parts[parts.length - 1] ?? "unknown";
    const moduleName = fileName.replace(/\.[^.]+$/, "");
    const lineCount = Math.max(source.split("\n").length, 1);
    return {
        id: { filePath, name: moduleName, kind: "Module" },
        name: moduleName,
        kind: "Module",
        filePath,
        byteRange: [0, source.length],
        lineRange: [0, lineCount],
        signature: undefined,
    };
}

// ---------------------------------------------------------------------------
// Rust parsing
// ---------------------------------------------------------------------------

function parseRust(filePath: string, content: string, language: Language): ParseResult {
    const parser = new Parser();
    parser.setLanguage(language);

    const tree = parser.parse(content);
    if (!tree) throw new Error(`Failed to parse file: ${filePath}`);

    const root = tree.rootNode;
    const symbols: SymbolDef[] = [];
    const references: SymbolRef[] = [];

    const moduleDef = makeModuleSymbol(filePath, content);
    const moduleId = moduleDef.id;

    for (const child of root.children) {
        if (!child) continue;
        switch (child.type) {
            case "function_item": {
                const nameNode = child.childForFieldName("name");
                if (nameNode) {
                    const name = nodeText(nameNode, content);
                    symbols.push(makeSymbolDef(filePath, content, child, name, "Function"));
                }
                break;
            }
            case "struct_item": {
                const nameNode = child.childForFieldName("name");
                if (nameNode) {
                    const name = nodeText(nameNode, content);
                    symbols.push(makeSymbolDef(filePath, content, child, name, "Struct"));
                }
                break;
            }
            case "enum_item": {
                const nameNode = child.childForFieldName("name");
                if (nameNode) {
                    const name = nodeText(nameNode, content);
                    symbols.push(makeSymbolDef(filePath, content, child, name, "Enum"));
                }
                break;
            }
            case "trait_item": {
                const nameNode = child.childForFieldName("name");
                if (nameNode) {
                    const name = nodeText(nameNode, content);
                    symbols.push(makeSymbolDef(filePath, content, child, name, "Trait"));
                }
                break;
            }
            case "impl_item": {
                extractRustImpl(filePath, content, child, symbols, references);
                break;
            }
            case "const_item": {
                const nameNode = child.childForFieldName("name");
                if (nameNode) {
                    const name = nodeText(nameNode, content);
                    symbols.push(makeSymbolDef(filePath, content, child, name, "Const"));
                }
                break;
            }
            case "type_item": {
                const nameNode = child.childForFieldName("name");
                if (nameNode) {
                    const name = nodeText(nameNode, content);
                    symbols.push(makeSymbolDef(filePath, content, child, name, "Type"));
                }
                break;
            }
            case "mod_item": {
                const nameNode = child.childForFieldName("name");
                if (nameNode) {
                    const name = nodeText(nameNode, content);
                    symbols.push(makeSymbolDef(filePath, content, child, name, "Module"));
                }
                break;
            }
            case "use_declaration": {
                const imported = collectRustUseImports(child, content);
                for (const [name, byteRange] of imported) {
                    references.push({
                        fromSymbol: moduleId,
                        toName: name,
                        refKind: "Import",
                        filePath,
                        byteRange,
                    });
                }
                break;
            }
        }
    }

    // Extract call and type references within function bodies
    for (const sym of [...symbols]) {
        if (sym.kind === "Function") {
            collectBodyRefs(filePath, content, root, sym.id, sym.byteRange, references);
        }
    }

    symbols.push(moduleDef);

    parser.delete();
    tree.delete();

    return { symbols, references };
}

function extractRustImpl(
    filePath: string,
    source: string,
    node: TSNode,
    symbols: SymbolDef[],
    references: SymbolRef[],
): void {
    const typeNode = node.childForFieldName("type");
    if (!typeNode) return;
    const typeName = nodeText(typeNode, source);

    const traitNode = node.childForFieldName("trait");
    let implName: string;

    if (traitNode) {
        const traitName = nodeText(traitNode, source);
        references.push({
            fromSymbol: {
                filePath,
                name: `${traitName} for ${typeName}`,
                kind: "Impl",
            },
            toName: traitName,
            refKind: "Impl",
            filePath,
            byteRange: [traitNode.startIndex, traitNode.endIndex],
        });
        implName = `${traitName} for ${typeName}`;
    } else {
        implName = typeName;
    }

    symbols.push(makeSymbolDef(filePath, source, node, implName, "Impl"));

    // Extract methods inside the impl block
    const body = node.childForFieldName("body");
    if (body) {
        for (const item of body.children) {
            if (!item) continue;
            if (item.type === "function_item") {
                const methodNameNode = item.childForFieldName("name");
                if (methodNameNode) {
                    const methodName = nodeText(methodNameNode, source);
                    const qualified = `${typeName}::${methodName}`;
                    symbols.push(makeSymbolDef(filePath, source, item, qualified, "Function"));
                }
            }
        }
    }
}

function collectRustUseImports(node: TSNode, source: string): [string, [number, number]][] {
    const names: [string, [number, number]][] = [];
    collectUseNamesRecursive(node, source, names);
    return names;
}

function collectUseNamesRecursive(
    node: TSNode,
    source: string,
    names: [string, [number, number]][],
): void {
    switch (node.type) {
        case "scoped_identifier": {
            const nameNode = node.childForFieldName("name");
            if (nameNode) {
                names.push([nodeText(nameNode, source), [nameNode.startIndex, nameNode.endIndex]]);
            }
            break;
        }
        case "identifier":
        case "type_identifier": {
            names.push([nodeText(node, source), [node.startIndex, node.endIndex]]);
            break;
        }
        case "use_list": {
            for (const child of node.children) {
                if (child) collectUseNamesRecursive(child, source, names);
            }
            break;
        }
        case "scoped_use_list": {
            const list = node.childForFieldName("list");
            if (list) collectUseNamesRecursive(list, source, names);
            break;
        }
        case "use_as_clause": {
            const alias = node.childForFieldName("alias");
            if (alias) {
                names.push([nodeText(alias, source), [alias.startIndex, alias.endIndex]]);
            } else {
                for (const child of node.children) {
                    if (!child) continue;
                    if (
                        child.type === "scoped_identifier" ||
                        child.type === "identifier" ||
                        child.type === "type_identifier"
                    ) {
                        collectUseNamesRecursive(child, source, names);
                        break;
                    }
                }
            }
            break;
        }
        case "use_wildcard": {
            // `use foo::*` — cannot determine specific names, skip
            break;
        }
        case "use_declaration": {
            for (const child of node.children) {
                if (!child) continue;
                const kind = child.type;
                if (kind !== "use" && kind !== ";" && kind !== "pub" && kind !== "crate") {
                    collectUseNamesRecursive(child, source, names);
                }
            }
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// TypeScript parsing
// ---------------------------------------------------------------------------

function parseTypescript(filePath: string, content: string, language: Language): ParseResult {
    const parser = new Parser();
    parser.setLanguage(language);

    const tree = parser.parse(content);
    if (!tree) throw new Error(`Failed to parse file: ${filePath}`);

    const root = tree.rootNode;
    const symbols: SymbolDef[] = [];
    const references: SymbolRef[] = [];

    const moduleDef = makeModuleSymbol(filePath, content);
    const moduleId = moduleDef.id;

    for (const child of root.children) {
        if (!child) continue;
        extractTsNode(filePath, content, child, moduleId, symbols, references);
    }

    // Extract call references within function bodies
    for (const sym of [...symbols]) {
        if (sym.kind === "Function") {
            collectBodyRefs(filePath, content, root, sym.id, sym.byteRange, references);
        }
    }

    symbols.push(moduleDef);

    parser.delete();
    tree.delete();

    return { symbols, references };
}

function extractTsNode(
    filePath: string,
    source: string,
    node: TSNode,
    moduleId: SymbolId,
    symbols: SymbolDef[],
    references: SymbolRef[],
): void {
    switch (node.type) {
        case "function_declaration": {
            const nameNode = node.childForFieldName("name");
            if (nameNode) {
                const name = nodeText(nameNode, source);
                symbols.push(makeSymbolDef(filePath, source, node, name, "Function"));
            }
            break;
        }
        case "class_declaration": {
            const nameNode = node.childForFieldName("name");
            if (nameNode) {
                const className = nodeText(nameNode, source);
                symbols.push(makeSymbolDef(filePath, source, node, className, "Class"));

                const body = node.childForFieldName("body");
                if (body) {
                    for (const item of body.children) {
                        if (!item) continue;
                        if (item.type === "method_definition") {
                            const methodNameNode = item.childForFieldName("name");
                            if (methodNameNode) {
                                const methodName = nodeText(methodNameNode, source);
                                const qualified = `${className}.${methodName}`;
                                symbols.push(makeSymbolDef(filePath, source, item, qualified, "Function"));
                            }
                        }
                    }
                }
            }
            break;
        }
        case "interface_declaration": {
            const nameNode = node.childForFieldName("name");
            if (nameNode) {
                const name = nodeText(nameNode, source);
                symbols.push(makeSymbolDef(filePath, source, node, name, "Interface"));
            }
            break;
        }
        case "type_alias_declaration": {
            const nameNode = node.childForFieldName("name");
            if (nameNode) {
                const name = nodeText(nameNode, source);
                symbols.push(makeSymbolDef(filePath, source, node, name, "Type"));
            }
            break;
        }
        case "enum_declaration": {
            const nameNode = node.childForFieldName("name");
            if (nameNode) {
                const name = nodeText(nameNode, source);
                symbols.push(makeSymbolDef(filePath, source, node, name, "Enum"));
            }
            break;
        }
        case "lexical_declaration": {
            for (const declarator of node.children) {
                if (!declarator) continue;
                if (declarator.type === "variable_declarator") {
                    const nameNode = declarator.childForFieldName("name");
                    if (nameNode && nameNode.type === "identifier") {
                        const name = nodeText(nameNode, source);
                        symbols.push(makeSymbolDef(filePath, source, declarator, name, "Const"));
                    }
                }
            }
            break;
        }
        case "import_statement": {
            const imported = collectTsImportNames(node, source);
            for (const [name, byteRange] of imported) {
                references.push({
                    fromSymbol: moduleId,
                    toName: name,
                    refKind: "Import",
                    filePath,
                    byteRange,
                });
            }
            break;
        }
        case "export_statement": {
            for (const exportChild of node.children) {
                if (exportChild) {
                    extractTsNode(filePath, source, exportChild, moduleId, symbols, references);
                }
            }
            break;
        }
    }
}

function collectTsImportNames(node: TSNode, source: string): [string, [number, number]][] {
    const names: [string, [number, number]][] = [];
    collectTsImportsRecursive(node, source, names);
    return names;
}

function collectTsImportsRecursive(
    node: TSNode,
    source: string,
    names: [string, [number, number]][],
): void {
    switch (node.type) {
        case "import_specifier": {
            const alias = node.childForFieldName("alias");
            if (alias) {
                names.push([nodeText(alias, source), [alias.startIndex, alias.endIndex]]);
            } else {
                const nameNode = node.childForFieldName("name");
                if (nameNode) {
                    names.push([nodeText(nameNode, source), [nameNode.startIndex, nameNode.endIndex]]);
                }
            }
            break;
        }
        case "namespace_import": {
            for (const child of node.children) {
                if (child && child.type === "identifier") {
                    names.push([nodeText(child, source), [child.startIndex, child.endIndex]]);
                }
            }
            break;
        }
        case "identifier": {
            names.push([nodeText(node, source), [node.startIndex, node.endIndex]]);
            break;
        }
        case "import_statement":
        case "import_clause":
        case "named_imports": {
            for (const child of node.children) {
                if (!child) continue;
                const kind = child.type;
                if (
                    kind !== "import" &&
                    kind !== "from" &&
                    kind !== "string" &&
                    kind !== "," &&
                    kind !== "{" &&
                    kind !== "}" &&
                    kind !== ";"
                ) {
                    collectTsImportsRecursive(child, source, names);
                }
            }
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Reference extraction within symbol bodies
// ---------------------------------------------------------------------------

const RUST_PRIMITIVE_TYPES = new Set([
    "i8", "i16", "i32", "i64", "i128",
    "u8", "u16", "u32", "u64", "u128",
    "f32", "f64",
    "bool", "str", "usize", "isize", "char",
    "String", "Self",
]);

function collectBodyRefs(
    filePath: string,
    source: string,
    root: TSNode,
    fromSymbol: SymbolId,
    targetRange: [number, number],
    references: SymbolRef[],
): void {
    findAndWalkBody(root, source, fromSymbol, targetRange, filePath, references);
}

function findAndWalkBody(
    node: TSNode,
    source: string,
    fromSymbol: SymbolId,
    targetRange: [number, number],
    filePath: string,
    references: SymbolRef[],
): void {
    const nStart = node.startIndex;
    const nEnd = node.endIndex;

    if (nStart === targetRange[0] && nEnd === targetRange[1]) {
        // Found the target symbol node — walk its body for refs
        const body = node.childForFieldName("body");
        if (body) {
            walkForRefs(body, source, fromSymbol, filePath, references);
        }
        return;
    }

    // Only recurse into children that overlap the target range
    if (nStart <= targetRange[0] && nEnd >= targetRange[1]) {
        for (const child of node.children) {
            if (child) {
                findAndWalkBody(child, source, fromSymbol, targetRange, filePath, references);
            }
        }
    }
}

function walkForRefs(
    node: TSNode,
    source: string,
    fromSymbol: SymbolId,
    filePath: string,
    references: SymbolRef[],
): void {
    switch (node.type) {
        case "call_expression": {
            const func = node.childForFieldName("function");
            if (func) {
                let funcName: string;
                switch (func.type) {
                    case "identifier":
                        funcName = nodeText(func, source);
                        break;
                    case "scoped_identifier":
                    case "field_expression":
                    case "member_expression": {
                        const leafNode =
                            func.childForFieldName("field") ??
                            func.childForFieldName("name") ??
                            func.childForFieldName("property");
                        funcName = leafNode ? nodeText(leafNode, source) : nodeText(func, source);
                        break;
                    }
                    default:
                        funcName = nodeText(func, source);
                        break;
                }
                references.push({
                    fromSymbol,
                    toName: funcName,
                    refKind: "Call",
                    filePath,
                    byteRange: [func.startIndex, func.endIndex],
                });
            }
            break;
        }
        case "type_identifier": {
            const typeName = nodeText(node, source);
            if (!RUST_PRIMITIVE_TYPES.has(typeName)) {
                references.push({
                    fromSymbol,
                    toName: typeName,
                    refKind: "TypeRef",
                    filePath,
                    byteRange: [node.startIndex, node.endIndex],
                });
            }
            break;
        }
    }

    // Recurse into children
    for (const child of node.children) {
        if (child) {
            walkForRefs(child, source, fromSymbol, filePath, references);
        }
    }
}

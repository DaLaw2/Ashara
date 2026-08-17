import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { GraphClient, Reranker, RankedResult, RetrievalConfig, RetrievalResult } from "@ashara/memory";
import { retrieve } from "@ashara/memory";
import type { ProjectProfile } from "./brief-assembly.js";

/** Signature for the retrieval function passed to brief assembly */
export type RetrieveFn = (query: string, mentionedSymbols?: string[]) => Promise<RetrievalResult[]>;

/** Stub reranker: returns documents in original order with linearly decreasing scores */
const stubReranker: Reranker = {
    async rerank(_query: string, documents: string[]): Promise<RankedResult[]> {
        return documents.map((doc, i) => ({
            index: i,
            score: 1.0 - i * 0.1,
            document: doc,
        }));
    },
};

/**
 * Create a retrieval function wired to graph and BM25 search.
 *
 * Throws on retrieval error so the caller (brief assembly) can distinguish
 * "nothing found" from "retrieval crashed" and route through its own fallback.
 */
export async function createRetrievalFn(graphClient: GraphClient): Promise<RetrieveFn> {
    const config: RetrievalConfig = {
        graphClient,
        reranker: stubReranker,
        graphHops: 2,
        keywordTopK: 20,
        finalTopK: 10,
    };

    return async (query: string, mentionedSymbols?: string[]): Promise<RetrievalResult[]> => {
        try {
            return await retrieve(config, query, mentionedSymbols);
        } catch (err) {
            console.warn("[Retrieval] query failed; propagating to brief assembly:", err);
            throw err;
        }
    };
}

// ---------------------------------------------------------------------------
// Project context auto-detection
// ---------------------------------------------------------------------------

const INSTRUCTION_FILES = ["CLAUDE.md", ".cursorrules", "opencode.md", "AGENTS.md", "CONVENTIONS.md"];
const MAX_INSTRUCTION_CHARS = 2000;
const MAX_LISTING_ENTRIES = 100;
const MAX_LISTING_DEPTH = 2;

async function readFileSafe(path: string, maxChars?: number): Promise<string | null> {
    try {
        const content = await readFile(path, "utf-8");
        return maxChars ? content.slice(0, maxChars) : content;
    } catch {
        return null;
    }
}

async function getDirectoryListing(dir: string, depth: number = 0): Promise<string[]> {
    if (depth >= MAX_LISTING_DEPTH) return [];

    try {
        const entries = await readdir(dir, { withFileTypes: true });
        const lines: string[] = [];
        const indent = "  ".repeat(depth);

        for (const entry of entries) {
            if (lines.length >= MAX_LISTING_ENTRIES) {
                lines.push(`${indent}... (truncated)`);
                break;
            }
            if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "target") continue;

            if (entry.isDirectory()) {
                lines.push(`${indent}${entry.name}/`);
                const children = await getDirectoryListing(join(dir, entry.name), depth + 1);
                lines.push(...children);
            } else {
                lines.push(`${indent}${entry.name}`);
            }
        }
        return lines;
    } catch {
        return [];
    }
}

const MANIFEST_HEAD_CHARS = 500;

/**
 * Read the head of every top-level text file and return formatted content
 * blocks for the decomposition LLM.
 *
 * Replaces the former hardcoded TECH_STACK_MARKERS iteration: a project
 * whose stack Ashara has never seen (composer.json, build.zig, mix.exs, …)
 * now reaches the planner with its own manifest contents.
 *
 * Bounds:
 *  - per-file: MANIFEST_HEAD_CHARS (500 chars)
 *  - count:    MAX_LISTING_ENTRIES  (100 files)
 *
 * Exclusion is by observable property only:
 *  - dotfiles  (convention: not project manifests)
 *  - directories
 *  - binary content (null byte in head)
 */
export async function readManifestContext(dir: string): Promise<string | undefined> {
    let entries: import("node:fs").Dirent[];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return undefined;
    }

    const sections: string[] = [];
    for (const entry of entries) {
        if (sections.length >= MAX_LISTING_ENTRIES) break;
        if (entry.name.startsWith(".") || entry.isDirectory()) continue;

        const filePath = join(dir, entry.name);
        const content = await readFileSafe(filePath, MANIFEST_HEAD_CHARS);
        if (content && content.trim().length > 0 && !content.includes("\0")) {
            sections.push(`--- ${entry.name} ---\n${content.trim()}\n--- end ---`);
        }
    }
    return sections.length > 0 ? sections.join("\n") : undefined;
}

/**
 * List non-dot, non-directory filenames at the project root.
 * Used by buildAutoProfile to populate techStack without a hardcoded table.
 */
async function listRootFiles(dir: string): Promise<string[]> {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
            if (files.length >= MAX_LISTING_ENTRIES) break;
            if (entry.name.startsWith(".") || entry.isDirectory()) continue;
            files.push(entry.name);
        }
        return files;
    } catch {
        return [];
    }
}

interface ScriptCommands {
    build?: string;
    test?: string;
    lint?: string;
}

// Node-specific by design: package.json scripts are always invoked via npm.
// The general (stack-agnostic) paths are detectScriptsFromJustfile and
// detectScriptsFromMakefile above, which work for any language.
async function detectScriptsFromPackageJson(dir: string): Promise<ScriptCommands> {
    const content = await readFileSafe(join(dir, "package.json"));
    if (!content) return {};

    try {
        const pkg = JSON.parse(content);
        const scripts = pkg.scripts ?? {};
        return {
            build: scripts.build ? `npm run build` : undefined,
            test: scripts.test ? `npm test` : undefined,
            lint: scripts.lint ? `npm run lint` : undefined,
        };
    } catch {
        return {};
    }
}

async function detectScriptsFromJustfile(dir: string): Promise<ScriptCommands> {
    const content = await readFileSafe(join(dir, "justfile")) ?? await readFileSafe(join(dir, "Justfile"));
    if (!content) return {};

    const hasRecipe = (name: string): boolean => new RegExp(`^${name}\\s*:`, "m").test(content);
    return {
        build: hasRecipe("build") ? "just build" : undefined,
        test: hasRecipe("test") ? "just test" : undefined,
        lint: hasRecipe("lint") ? "just lint" : undefined,
    };
}

async function detectScriptsFromMakefile(dir: string): Promise<ScriptCommands> {
    const content = await readFileSafe(join(dir, "Makefile"));
    if (!content) return {};

    const hasTarget = (name: string): boolean => new RegExp(`^${name}\\s*:`, "m").test(content);
    return {
        build: hasTarget("build") ? "make build" : undefined,
        test: hasTarget("test") ? "make test" : undefined,
        lint: hasTarget("lint") ? "make lint" : undefined,
    };
}

async function detectCommands(dir: string): Promise<ScriptCommands> {
    const justScripts = await detectScriptsFromJustfile(dir);
    if (justScripts.build ?? justScripts.test ?? justScripts.lint) return justScripts;

    const makeScripts = await detectScriptsFromMakefile(dir);
    if (makeScripts.build ?? makeScripts.test ?? makeScripts.lint) return makeScripts;

    const pkgScripts = await detectScriptsFromPackageJson(dir);
    if (pkgScripts.build ?? pkgScripts.test ?? pkgScripts.lint) return pkgScripts;

    return {};
}

export async function buildAutoProfile(workingDir: string): Promise<ProjectProfile> {
    const techStack = await listRootFiles(workingDir);
    const commands = await detectCommands(workingDir);

    return {
        name: basename(workingDir),
        techStack,
        buildCommand: commands.build ?? "echo 'no build configured'",
        testCommand: commands.test ?? "echo 'no tests configured'",
        lintCommand: commands.lint ?? "echo 'no lint configured'",
        conventions: [],
        moduleBoundaries: "",
    };
}

export async function buildProjectContext(workingDir: string): Promise<string> {
    const sections: string[] = [];

    const listing = await getDirectoryListing(workingDir);
    if (listing.length > 0) {
        sections.push(`# Project Structure\n${listing.join("\n")}`);
    }

    for (const filename of INSTRUCTION_FILES) {
        const content = await readFileSafe(join(workingDir, filename), MAX_INSTRUCTION_CHARS);
        if (content) {
            sections.push(`# ${filename}\n${content}`);
        }
    }

    // The # Tech Stack section is removed: it rendered marker FILENAMES
    // (e.g., "Cargo.toml") instead of language labels, contradicting the
    // ProjectFrame the prompt already carries (ADR-046). The project
    // structure listing above already shows what files exist at the root.

    return sections.join("\n\n");
}

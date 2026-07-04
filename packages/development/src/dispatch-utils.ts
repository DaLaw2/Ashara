import { readdir, readFile, stat } from "node:fs/promises";
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
 * Falls back gracefully: if a route fails, returns empty results instead of
 * crashing the dispatch pipeline.
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
            console.warn(`[Retrieval] query failed, returning empty:`, err instanceof Error ? err.message : err);
            return [];
        }
    };
}

/** Build a default project profile when no project-specific detection is available. */
export function buildDefaultProfile(): ProjectProfile {
    return {
        name: "project",
        techStack: [],
        buildCommand: "echo 'no build configured'",
        testCommand: "echo 'no tests configured'",
        lintCommand: "echo 'no lint configured'",
        conventions: [],
        moduleBoundaries: "",
    };
}

// ---------------------------------------------------------------------------
// Project context auto-detection
// ---------------------------------------------------------------------------

const INSTRUCTION_FILES = ["CLAUDE.md", ".cursorrules", "opencode.md", "AGENTS.md", "CONVENTIONS.md"];
const MAX_INSTRUCTION_CHARS = 2000;
const MAX_LISTING_ENTRIES = 100;
const MAX_LISTING_DEPTH = 2;

const TECH_STACK_MARKERS: readonly string[] = [
    "Cargo.toml",
    "package.json",
    "tsconfig.json",
    "go.mod",
    "pyproject.toml",
    "requirements.txt",
    "Gemfile",
    "pom.xml",
    "build.gradle",
];

async function fileExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

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

export async function detectTechStack(dir: string): Promise<string[]> {
    const detected: string[] = [];
    for (const marker of TECH_STACK_MARKERS) {
        if (await fileExists(join(dir, marker))) {
            detected.push(marker);
        }
    }
    return detected;
}

const MANIFEST_HEAD_CHARS = 500;

export async function readManifestContext(dir: string): Promise<string | undefined> {
    const sections: string[] = [];
    for (const marker of TECH_STACK_MARKERS) {
        const filePath = join(dir, marker);
        const content = await readFileSafe(filePath, MANIFEST_HEAD_CHARS);
        if (content && content.trim().length > 0) {
            sections.push(`--- ${marker} ---\n${content.trim()}\n--- end ---`);
        }
    }
    return sections.length > 0 ? sections.join("\n") : undefined;
}

interface ScriptCommands {
    build?: string;
    test?: string;
    lint?: string;
}

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
    const techStack = await detectTechStack(workingDir);
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

    const techStack = await detectTechStack(workingDir);
    if (techStack.length > 0) {
        sections.push(`# Tech Stack\n${techStack.join(", ")}`);
    }

    return sections.join("\n\n");
}

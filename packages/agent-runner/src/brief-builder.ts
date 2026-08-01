import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentBrief } from "@ashara/shared";
import { createProfileAdapter } from "./acl/development-acl.js";
import type { ProjectProfilePort } from "./acl/development-acl.js";

/**
 * Enrich an existing AgentBrief (from brief.json) with project context.
 *
 * Called by the runner to augment the brief with the auto-detected project
 * profile, directory listing, and instruction files.
 *
 * The profile block is SUPPRESSED when detection found no tech-stack marker
 * (ADR-046): on an empty tree it would otherwise render an empty "Tech Stack"
 * section under a second "# Project" heading, contradicting the ProjectFrame the
 * prompt already states. Two Project sections that disagree are worse than one
 * that is right — and the empty one always looks like the more concrete evidence.
 */
export async function enrichBrief(
    brief: AgentBrief,
    projectDir: string,
    profiles: ProjectProfilePort = createProfileAdapter(),
): Promise<AgentBrief> {
    const projectContext = await profiles.buildProjectContext(projectDir);
    const projectProfile = await profiles.buildAutoProfile(projectDir);

    const profileText =
        projectProfile.techStack.length > 0 ? profiles.formatProjectProfile(projectProfile) : "";

    const enrichedContext = [
        brief.context,
        "",
        profileText,
        "",
        projectContext,
    ]
        .filter(Boolean)
        .join("\n");

    return {
        ...brief,
        context: enrichedContext,
    };
}

// ---------------------------------------------------------------------------
// extractProjectConventions — reads actual project state and formats patterns
// ---------------------------------------------------------------------------

// Build-artifact directories by convention — large generated trees that add
// noise. .gitignore-based exclusion is the intended general replacement.
const SKIP_DIRS = new Set([
    "node_modules",
    "target",
    "__pycache__",
    "vendor",
    "build",
    "dist",
    ".gradle",
    "obj",
    "bin",
]);

const EXEMPLAR_DIR_CANDIDATES = [
    "src/routes",
    "src/api",
    "routes",
    "api",
    "src/commands",
    "src/handlers",
    "internal",
    "pkg",
];

async function fileExistsSafe(path: string): Promise<boolean> {
    try {
        const s = await stat(path);
        return s.isFile();
    } catch {
        return false;
    }
}

async function dirExistsSafe(path: string): Promise<boolean> {
    try {
        const s = await stat(path);
        return s.isDirectory();
    } catch {
        return false;
    }
}

async function readFirstLines(filePath: string, lineCount: number): Promise<string> {
    try {
        const content = await readFile(filePath, "utf-8");
        return content.split("\n").slice(0, lineCount).join("\n");
    } catch {
        return "";
    }
}

async function listSrcTree(projectDir: string): Promise<string[]> {
    const srcDir = join(projectDir, "src");
    if (!(await dirExistsSafe(srcDir))) return [];

    const files: string[] = [];
    await collectFiles(srcDir, "src", files, 0, 2);
    return files;
}

async function collectFiles(
    dir: string,
    prefix: string,
    out: string[],
    depth: number,
    maxDepth: number,
): Promise<void> {
    if (depth >= maxDepth || out.length >= 50) return;

    try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (out.length >= 50) break;
            if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;

            const relativePath = `${prefix}/${entry.name}`;
            if (entry.isDirectory()) {
                out.push(`${relativePath}/`);
                await collectFiles(join(dir, entry.name), relativePath, out, depth + 1, maxDepth);
            } else {
                out.push(relativePath);
            }
        }
    } catch (e: unknown) {
        console.warn(`[collectFiles] Failed to read directory ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
}

export async function extractProjectConventions(projectDir: string): Promise<string> {
    const pkgPath = join(projectDir, "package.json");
    if (!(await fileExistsSafe(pkgPath))) {
        return extractGeneralConventions(projectDir);
    }

    const sections: string[] = [];
    sections.push("## Project State (follow these patterns)");

    let dependencies: string[] = [];
    let entryFromPkg: string | null = null;
    try {
        const raw = await readFile(pkgPath, "utf-8");
        // contract-erasing: package.json has a well-known shape (npm spec)
        const pkg = JSON.parse(raw) as Record<string, unknown>;

        // contract-erasing: dependencies/devDependencies are Record<string, string>
        const deps = pkg["dependencies"] as Record<string, unknown> | undefined;
        const devDeps = pkg["devDependencies"] as Record<string, unknown> | undefined; // contract-erasing
        if (deps) dependencies.push(...Object.keys(deps));
        if (devDeps) dependencies.push(...Object.keys(devDeps));

        if (typeof pkg["main"] === "string") entryFromPkg = pkg["main"] as string;

        // contract-erasing: scripts is Record<string, string>
        const scripts = pkg["scripts"] as Record<string, unknown> | undefined;
        if (scripts) {
            const scriptNames = Object.keys(scripts).slice(0, 10);
            if (scriptNames.length > 0) {
                sections.push(`Scripts: ${scriptNames.join(", ")}`);
            }
        }
    } catch {
        return "";
    }

    if (dependencies.length > 0) {
        sections.push(`Dependencies: ${dependencies.slice(0, 20).join(", ")}`);
    }

    const entryPoint = entryFromPkg && (await fileExistsSafe(join(projectDir, entryFromPkg)))
        ? entryFromPkg
        : null;

    await appendConventionsTail(sections, projectDir, entryPoint);

    if (sections.length <= 2) return "";

    return sections.join("\n");
}

// NON_JS_MANIFESTS deleted: the hardcoded {Cargo.toml, go.mod, pyproject.toml}
// table silently skipped manifests Ashara had never seen. readManifestContext
// (development/dispatch-utils.ts) already reads ALL top-level files generically
// for the decomposition LLM; this side reads any text config file it finds.
const NON_SOURCE_SKIP = new Set(["license", "readme", "changelog", "contributing", "authors"]);

async function extractGeneralConventions(projectDir: string): Promise<string> {
    const sections: string[] = [];
    let entries: string[];
    try {
        entries = await readdir(projectDir);
    } catch {
        return "";
    }

    sections.push("## Project State (follow these patterns)");

    for (const name of entries.sort()) {
        if (name.startsWith(".")) continue;
        if (NON_SOURCE_SKIP.has(name.toLowerCase().replace(/\.[^.]+$/, ""))) continue;
        const full = join(projectDir, name);
        if (!(await fileExistsSafe(full))) continue;
        const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
        if (["toml", "json", "yaml", "yml", "mod", "sbt", "gradle", "xml", "lock"].includes(ext)
            || name === "Makefile" || name === "Justfile" || name === "Gemfile"
            || name === "Rakefile" || name === "CMakeLists.txt") {
            const raw = await readFirstLines(full, 30);
            if (raw.trim()) {
                sections.push(`${name}:\n${indent(raw)}`);
            }
        }
        if (sections.length > 6) break;
    }

    if (sections.length <= 1) return "";

    await appendConventionsTail(sections, projectDir, null);

    return sections.join("\n");
}

async function appendConventionsTail(
    sections: string[],
    projectDir: string,
    entryPoint: string | null,
): Promise<void> {
    if (entryPoint) {
        sections.push(`Entry point: ${entryPoint}`);
        const head = await readFirstLines(join(projectDir, entryPoint), 30);
        if (head.trim()) {
            sections.push(`Entry point pattern:\n${indent(head)}`);
        }
    }

    const tree = await listSrcTree(projectDir);
    if (tree.length > 0) {
        sections.push(`File tree:\n  ${tree.join(", ")}`);
    }

    for (const exemplarDir of EXEMPLAR_DIR_CANDIDATES) {
        const fullDir = join(projectDir, exemplarDir);
        if (!(await dirExistsSafe(fullDir))) continue;
        try {
            const entries = await readdir(fullDir);
            const exemplarFile = entries.find(
                (e) => {
                    const dot = e.lastIndexOf(".");
                    if (dot <= 0) return false;
                    const ext = e.slice(dot).toLowerCase();
                    const nonSource = new Set([".json", ".yaml", ".yml", ".toml", ".xml", ".md", ".txt", ".lock", ".sum"]);
                    return !nonSource.has(ext) && !e.startsWith(".");
                },
            );
            if (exemplarFile) {
                const exemplarPath = `${exemplarDir}/${exemplarFile}`;
                const head = await readFirstLines(join(fullDir, exemplarFile), 15);
                if (head.trim()) {
                    sections.push(`Code pattern (from ${exemplarPath}):\n${indent(head)}`);
                }
                break;
            }
        } catch {
            continue;
        }
    }

    sections.push(
        "\nFollow these existing patterns. Do not introduce alternative libraries or patterns.",
    );
}

// Entry-point detection cascade deleted: the hand-written per-ecosystem
// checks (Cargo → src/main.rs, Go → main.go, Python → pyproject.toml
// scripts) covered only 4 stacks and silently returned null for everything
// else. The manifest content surfaced by extractGeneralConventions and
// readManifestContext is sufficient for the LLM to infer entry points.

function indent(text: string): string {
    return text
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
}

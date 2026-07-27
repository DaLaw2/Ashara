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
        return extractNonJsConventions(projectDir);
    }

    const sections: string[] = [];
    sections.push("## Project State (follow these patterns)");

    let dependencies: string[] = [];
    let entryFromPkg: string | null = null;
    try {
        const raw = await readFile(pkgPath, "utf-8");
        const pkg = JSON.parse(raw) as Record<string, unknown>;

        const deps = pkg["dependencies"] as Record<string, unknown> | undefined;
        const devDeps = pkg["devDependencies"] as Record<string, unknown> | undefined;
        if (deps) dependencies.push(...Object.keys(deps));
        if (devDeps) dependencies.push(...Object.keys(devDeps));

        if (typeof pkg["main"] === "string") entryFromPkg = pkg["main"] as string;

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

    let entryPoint: string | null = null;
    if (entryFromPkg && (await fileExistsSafe(join(projectDir, entryFromPkg)))) {
        entryPoint = entryFromPkg;
    } else {
        entryPoint = await detectEntryPointFromManifest(projectDir);
    }

    await appendConventionsTail(sections, projectDir, entryPoint);

    if (sections.length <= 2) return "";

    return sections.join("\n");
}

const NON_JS_MANIFESTS = [
    { path: "Cargo.toml", lines: 40 },
    { path: "go.mod", lines: 30 },
    { path: "pyproject.toml", lines: 30 },
] as const;

async function extractNonJsConventions(projectDir: string): Promise<string> {
    const sections: string[] = [];

    for (const manifest of NON_JS_MANIFESTS) {
        const fullPath = join(projectDir, manifest.path);
        if (await fileExistsSafe(fullPath)) {
            sections.push("## Project State (follow these patterns)");
            const raw = await readFirstLines(fullPath, manifest.lines);
            if (raw.trim()) {
                sections.push(`${manifest.path}:\n${indent(raw)}`);
            }
            break;
        }
    }

    if (sections.length === 0) return "";

    const ep = await detectEntryPointFromManifest(projectDir);
    const entryPoint = ep && (await fileExistsSafe(join(projectDir, ep))) ? ep : null;

    await appendConventionsTail(sections, projectDir, entryPoint);

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
                (e) =>
                    e.endsWith(".ts") ||
                    e.endsWith(".js") ||
                    e.endsWith(".rs") ||
                    e.endsWith(".go") ||
                    e.endsWith(".py"),
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

async function detectEntryPointFromManifest(projectDir: string): Promise<string | null> {
    try {
        const pkgPath = join(projectDir, "package.json");
        const raw = await readFile(pkgPath, "utf-8").catch(() => null);
        if (raw) {
            const pkg = JSON.parse(raw) as Record<string, unknown>;
            if (typeof pkg.main === "string") return pkg.main;
        }
    } catch (e: unknown) {
        console.warn(`[detectEntryPoint] Failed to parse package.json in ${projectDir}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const cargoEntry = await detectCargoEntryPoint(projectDir);
    if (cargoEntry !== undefined) return cargoEntry;

    const goEntry = await detectGoEntryPoint(projectDir);
    if (goEntry !== undefined) return goEntry;

    const pyEntry = await detectPyEntryPoint(projectDir);
    if (pyEntry !== undefined) return pyEntry;

    return null;
}

async function detectCargoEntryPoint(projectDir: string): Promise<string | null | undefined> {
    const cargoPath = join(projectDir, "Cargo.toml");
    if (!(await fileExistsSafe(cargoPath))) return undefined;

    try {
        const content = await readFile(cargoPath, "utf-8");
        const binPathMatch = /\[\[bin]]\s[\s\S]*?path\s*=\s*"([^"]+)"/m.exec(content);
        if (binPathMatch?.[1]) return binPathMatch[1];
    } catch (e: unknown) {
        console.warn(`[detectCargoEntry] Failed to parse Cargo.toml in ${projectDir}: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (await fileExistsSafe(join(projectDir, "src/main.rs"))) return "src/main.rs";
    if (await fileExistsSafe(join(projectDir, "src/lib.rs"))) return "src/lib.rs";
    return null;
}

async function detectGoEntryPoint(projectDir: string): Promise<string | null | undefined> {
    if (!(await fileExistsSafe(join(projectDir, "go.mod")))) return undefined;
    if (await fileExistsSafe(join(projectDir, "main.go"))) return "main.go";
    if (await fileExistsSafe(join(projectDir, "cmd/main.go"))) return "cmd/main.go";
    return null;
}

async function detectPyEntryPoint(projectDir: string): Promise<string | null | undefined> {
    const pyprojectPath = join(projectDir, "pyproject.toml");
    if (!(await fileExistsSafe(pyprojectPath))) return undefined;

    try {
        const content = await readFile(pyprojectPath, "utf-8");
        const scriptsMatch = /\[(?:project\.scripts|tool\.poetry\.scripts)]\s*\n([\s\S]*?)(?:\n\[|\z)/m.exec(content);
        if (scriptsMatch?.[1]) {
            const entryMatch = /=\s*"([^"]+)"/m.exec(scriptsMatch[1]);
            if (entryMatch?.[1]) {
                const moduleRef = entryMatch[1].split(":")[0];
                const filePath = moduleRef.replace(/\./g, "/") + ".py";
                if (await fileExistsSafe(join(projectDir, filePath))) return filePath;
            }
        }
    } catch (e: unknown) {
        console.warn(`[detectPyEntry] Failed to parse pyproject.toml in ${projectDir}: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (await fileExistsSafe(join(projectDir, "main.py"))) return "main.py";
    if (await fileExistsSafe(join(projectDir, "app.py"))) return "app.py";
    return null;
}

function indent(text: string): string {
    return text
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
}

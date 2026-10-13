import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function readFileSafe(path: string, maxChars?: number): Promise<string | null> {
    try {
        const content = await readFile(path, "utf-8");
        return maxChars ? content.slice(0, maxChars) : content;
    } catch {
        return null;
    }
}

const MANIFEST_HEAD_CHARS = 500;
const MAX_LISTING_ENTRIES = 100;

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

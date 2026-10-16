import { listTreeDir, readTreeFile } from "@ashara/execution-infra";

const MANIFEST_HEAD_CHARS = 500;
// UTF-8 needs at most four bytes per character.
const MANIFEST_HEAD_BYTES = MANIFEST_HEAD_CHARS * 4;
const MAX_LISTING_ENTRIES = 100;

/**
 * Read the head of every top-level text file and return formatted content
 * blocks for the brief's context map.
 *
 * No list of manifest names (Target Generality): a project whose stack
 * Ashara has never seen (composer.json, build.zig, mix.exs, …) reaches the
 * agent with its own manifest contents.
 *
 * Bounds:
 *  - per-file: MANIFEST_HEAD_CHARS (500 chars)
 *  - count:    MAX_LISTING_ENTRIES  (100 files)
 *
 * Exclusion is by observable property only:
 *  - dotfiles  (convention: not project manifests)
 *  - anything but a regular file: directories, and symbolic links, which a
 *    cell can point at a host file (tree-read.ts)
 *  - binary content (null byte in head)
 *
 * `dir` is a cell-writable tree, so every read goes through tree-read.ts; a
 * refusal there throws rather than being skipped.
 */
export async function readManifestContext(dir: string): Promise<string | undefined> {
    const entries = await listTreeDir(dir);
    if (entries === null) return undefined;

    const sections: string[] = [];
    for (const entry of entries) {
        if (sections.length >= MAX_LISTING_ENTRIES) break;
        if (entry.name.startsWith(".") || entry.kind !== "file") continue;

        const read = await readTreeFile(dir, entry.name, MANIFEST_HEAD_BYTES);
        if (read.kind === "absent") continue;
        const content = read.text.slice(0, MANIFEST_HEAD_CHARS);
        if (content.trim().length > 0 && !content.includes("\0")) {
            sections.push(`--- ${entry.name} ---\n${content.trim()}\n--- end ---`);
        }
    }
    return sections.length > 0 ? sections.join("\n") : undefined;
}

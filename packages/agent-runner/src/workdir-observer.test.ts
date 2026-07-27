import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import {
    snapshotWorkdir,
    hasProgressSince,
    EMPTY_SNAPSHOT,
    WorkdirObservationError,
} from "./workdir-observer.js";
import type { WorkdirSnapshot } from "./workdir-observer.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
}

/** Initializes a bare git repo with one empty commit, ready for file creation. */
async function initRepo(dir: string): Promise<void> {
    await git(dir, "init", "-b", "main");
    await git(dir, "config", "user.email", "test@test.local");
    await git(dir, "config", "user.name", "Test");
    await git(dir, "commit", "--allow-empty", "-m", "init");
}

afterAll(async () => {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// snapshotWorkdir — content-aware observation
// ---------------------------------------------------------------------------

describe("snapshotWorkdir", () => {
    test("expands untracked directories to individual files", async () => {
        const dir = await makeDir("ashara-snap-expand-");
        await initRepo(dir);

        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "Cargo.toml"), '[package]\nname = "hello"', "utf-8");
        await writeFile(join(dir, "src/main.rs"), 'fn main() {}', "utf-8");

        const s = await snapshotWorkdir(dir);
        expect(s.files.has("Cargo.toml")).toBe(true);
        expect(s.files.has("src/main.rs")).toBe(true);
        expect(s.files.has("src/")).toBe(false);
        expect(s.truncated).toBe(false);
    });

    test("produces different hashes for different content at the same path", async () => {
        const dir = await makeDir("ashara-snap-hash-");
        await initRepo(dir);

        await writeFile(join(dir, "app.ts"), "version 1", "utf-8");
        const snap1 = await snapshotWorkdir(dir);

        await writeFile(join(dir, "app.ts"), "version 2", "utf-8");
        const snap2 = await snapshotWorkdir(dir);

        expect(snap1.files.get("app.ts")).not.toBe(snap2.files.get("app.ts"));
    });

    test("excludes .ashara/ control directory files", async () => {
        const dir = await makeDir("ashara-snap-ctrl-");
        await initRepo(dir);

        await mkdir(join(dir, ".ashara"), { recursive: true });
        await writeFile(join(dir, ".ashara", "brief.json"), "{}", "utf-8");
        await writeFile(join(dir, "real-file.ts"), "export const x = 1;", "utf-8");

        const s = await snapshotWorkdir(dir);
        expect(s.files.has("real-file.ts")).toBe(true);
        expect([...s.files.keys()].every((f) => !f.startsWith(".ashara"))).toBe(true);
    });

    test("throws WorkdirObservationError for non-git directory (fail-closed)", async () => {
        const dir = await makeDir("ashara-snap-nongit-");
        await expect(snapshotWorkdir(dir)).rejects.toThrow(WorkdirObservationError);
    });

    test("throws WorkdirObservationError for missing directory (fail-closed)", async () => {
        await expect(snapshotWorkdir("/nonexistent-dir-abc123")).rejects.toThrow(
            WorkdirObservationError,
        );
    });
});

// ---------------------------------------------------------------------------
// hasProgressSince — content-aware diff
// ---------------------------------------------------------------------------

function snap(
    entries: readonly (readonly [string, string])[],
    truncated = false,
): WorkdirSnapshot {
    return { files: new Map(entries), truncated, totalPaths: entries.length };
}

describe("hasProgressSince", () => {
    test("detects new file creation (first observation)", () => {
        expect(hasProgressSince(EMPTY_SNAPSHOT, snap([["Cargo.toml", "abc123"]]))).toBe(true);
    });

    test("detects content change to an existing file (the regression case)", () => {
        const previous = snap([["app.ts", "hash-v1"]]);
        const current = snap([["app.ts", "hash-v2"]]);
        expect(hasProgressSince(previous, current)).toBe(true);
    });

    test("detects file deletion as progress", () => {
        const previous = snap([["old.ts", "hash1"], ["keep.ts", "hash2"]]);
        const current = snap([["keep.ts", "hash2"]]);
        expect(hasProgressSince(previous, current)).toBe(true);
    });

    test("returns false when nothing changed (same paths, same hashes)", () => {
        const s = snap([["app.ts", "same-hash"]]);
        expect(hasProgressSince(s, s)).toBe(false);
    });

    test("returns false when both are empty", () => {
        expect(hasProgressSince(EMPTY_SNAPSHOT, EMPTY_SNAPSHOT)).toBe(false);
    });

    test("a truncated snapshot reads as progress — it cannot prove absence", () => {
        const complete = snap([["app.ts", "h"]]);
        const cut = snap([["app.ts", "h"]], true);
        expect(hasProgressSince(complete, complete)).toBe(false);
        expect(hasProgressSince(complete, cut)).toBe(true);
        expect(hasProgressSince(cut, complete)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Observation cap — snapshotWorkdir truncation
// ---------------------------------------------------------------------------

describe("observation cap", () => {
    test("snapshotWorkdir marks as truncated beyond the cap and reports progress", async () => {
        const dir = await makeDir("ashara-snap-cap-");
        await initRepo(dir);

        // MAX_SNAPSHOT_FILES is internal (2000), create beyond it
        const count = 2050;
        for (let i = 0; i < count; i++) {
            await writeFile(join(dir, `file-${String(i).padStart(5, "0")}.txt`), `content-${i}`, "utf-8");
        }

        const snapshot = await snapshotWorkdir(dir);
        expect(snapshot.truncated).toBe(true);
        expect(snapshot.totalPaths).toBe(count);

        // A truncated snapshot always reads as progress — the nudge must
        // NOT fire when we could not observe the full tree.
        expect(hasProgressSince(EMPTY_SNAPSHOT, snapshot)).toBe(true);
        expect(hasProgressSince(snapshot, snapshot)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Integration: edit-existing-file across turns (the regression test)
// ---------------------------------------------------------------------------

describe("content-aware progress across turns (integration)", () => {
    test("agent that creates a file then modifies it is making progress on ALL turns", async () => {
        const dir = await makeDir("ashara-progress-edit-");
        await initRepo(dir);

        // Turn 1: agent creates file via run_command (e.g. cargo init)
        await writeFile(join(dir, "main.rs"), 'fn main() { println!("v1"); }', "utf-8");
        const snap1 = await snapshotWorkdir(dir);
        expect(hasProgressSince(EMPTY_SNAPSHOT, snap1)).toBe(true);

        // Turn 2: agent modifies the same file (compile-fail -> edit -> recompile)
        await writeFile(join(dir, "main.rs"), 'fn main() { println!("v2"); }\nfn helper() {}', "utf-8");
        const snap2 = await snapshotWorkdir(dir);
        expect(hasProgressSince(snap1, snap2)).toBe(true);

        // Turn 3: agent modifies it again
        await writeFile(join(dir, "main.rs"), 'fn main() { helper(); }\nfn helper() { println!("v3"); }', "utf-8");
        const snap3 = await snapshotWorkdir(dir);
        expect(hasProgressSince(snap2, snap3)).toBe(true);
    });

    test("agent that does nothing between observations is NOT making progress", async () => {
        const dir = await makeDir("ashara-progress-idle-");
        await initRepo(dir);

        await writeFile(join(dir, "app.ts"), "const x = 1;", "utf-8");
        const snap1 = await snapshotWorkdir(dir);

        // No file changes between snapshots
        const snap2 = await snapshotWorkdir(dir);
        expect(hasProgressSince(snap1, snap2)).toBe(false);
    });
});

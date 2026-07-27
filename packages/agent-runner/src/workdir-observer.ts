import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isAsharaControlPath } from "@ashara/shared";

const execFileAsync = promisify(execFile);

/**
 * Files changed in a git working directory, observed via `git status`.
 *
 * This is NOT a re-export of development's `getChangedFiles` routed through
 * the ACL. It is the same seven-line `git status --porcelain` observation
 * using the same shared-kernel filter (`isAsharaControlPath`). The ACL
 * exists for anti-corruption at BC boundaries — translating domain types
 * between bounded contexts. A filesystem observation is infrastructure, not
 * domain translation, and routing it through the ACL would misuse the ACL
 * as a general function-forwarding layer. Since both the git exec and the
 * filter are available to agent-runner independently — the former via
 * `child_process`, the latter via `@ashara/shared` — using the same shared
 * utility for the same reason in two packages is not duplication.
 *
 * Cost: ~5ms on a typical project worktree. `git status` only walks tracked
 * and untracked non-ignored files; `target/`, `node_modules/`, and other
 * gitignored trees are excluded by git itself. The workdir is a git worktree
 * with `.ashara/` in its exclude file (written by workspace.ts's
 * `excludeControlDir`), so the control directory produces no entries.
 */
export class WorkdirObservationError extends Error {
    constructor(
        public readonly workDir: string,
        public readonly operation: string,
        cause?: unknown,
    ) {
        const causeMsg = cause instanceof Error ? cause.message : String(cause ?? "");
        super(`workdir observation failed (${operation}) in ${workDir}: ${causeMsg}`);
        this.name = "WorkdirObservationError";
    }
}

// ---------------------------------------------------------------------------
// Git status — shared primitive
// ---------------------------------------------------------------------------

/**
 * Runs `git status --porcelain` and returns the list of changed file paths,
 * excluding Ashara's own control directory.
 *
 * Always passes `--untracked-files=all`. Without it git groups an untracked
 * directory as a single entry (`?? src/`) instead of naming its files
 * (`?? src/main.rs`), and {@link snapshotWorkdir} cannot hash a directory
 * entry.
 */
async function gitStatusPaths(workDir: string): Promise<string[]> {
    const args = ["status", "--porcelain", "--untracked-files=all"];

    let stdout: string;
    try {
        const result = await execFileAsync("git", args, { cwd: workDir });
        stdout = result.stdout;
    } catch (e: unknown) {
        throw new WorkdirObservationError(workDir, "git status", e);
    }
    return stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => line.slice(3).trim())
        .filter((path) => !isAsharaControlPath(path));
}

// ---------------------------------------------------------------------------
// Content-aware snapshot (conversation.ts — "did the agent make progress?")
// ---------------------------------------------------------------------------

/**
 * A content-aware snapshot of the working directory's changed files.
 * Each entry maps a file path to a SHA-256 hash of its content, so two
 * snapshots of the same path with different content compare as different.
 *
 * This is the signal for the nudge's progress check: an agent that edits
 * an existing file it already created produces the same path set but a
 * different content hash, and that must count as progress.
 */
export interface WorkdirSnapshot {
    readonly files: ReadonlyMap<string, string>;
    /**
     * True when the observation could not cover everything git reported —
     * see {@link MAX_SNAPSHOT_FILES}. A truncated snapshot cannot prove the
     * absence of progress, and {@link hasProgressSince} treats it accordingly.
     */
    readonly truncated: boolean;
    /** How many paths git reported, whether or not all were fingerprinted. */
    readonly totalPaths: number;
}

const EMPTY_SNAPSHOT: WorkdirSnapshot = { files: new Map(), truncated: false, totalPaths: 0 };

export { EMPTY_SNAPSHOT };

/**
 * Ceiling on fingerprinted files per snapshot.
 *
 * There is a window where the unbounded count is not hypothetical, and it
 * exists by design: `workspace.ts:207-214` records that Ashara deliberately
 * does NOT pre-write a `.gitignore`, because a guess written before the stack
 * is known suppresses the agent's own correct answer. So between the agent
 * fetching dependencies and the agent authoring `.gitignore`, the entire
 * dependency tree is untracked and git reports every file in it. "git excludes
 * gitignored trees" is true only once the ignore file exists.
 */
const MAX_SNAPSHOT_FILES = 2000;

/**
 * Above this size a file is fingerprinted by `size:mtime` instead of by
 * content hash. Reading an arbitrarily large artifact into memory once per
 * conversation turn is its own failure mode, and a build output that changes
 * always changes its size or mtime too.
 */
const MAX_HASHED_BYTES = 4 * 1024 * 1024;

/**
 * Snapshot the working directory: path set from `git status` plus a
 * SHA-256 content hash for each file.
 *
 * Uses `--untracked-files=all` so that untracked directories are expanded
 * to individual files — without it, `git status --porcelain` groups an
 * untracked directory as e.g. `?? src/`, and we cannot hash a directory
 * entry, which means editing `src/main.rs` after creating it would be
 * invisible.
 *
 * Cost: `git status --porcelain --untracked-files=all` is ~5ms. The hash step
 * reads each file once; on a typical agent worktree the changed-file count is
 * well under a hundred small files, so it is negligible.
 *
 * That "typical" is doing real work, which is why {@link MAX_SNAPSHOT_FILES}
 * exists. Gitignored trees are excluded by git — but only once a `.gitignore`
 * exists, and Ashara deliberately does not write one before the agent does.
 */
export async function snapshotWorkdir(workDir: string): Promise<WorkdirSnapshot> {
    const paths = await gitStatusPaths(workDir);
    const files = new Map<string, string>();
    const truncated = paths.length > MAX_SNAPSHOT_FILES;

    if (truncated) {
        // Never truncate silently: a bounded observation that reports like a
        // complete one reads as "covered everything" when it did not.
        console.warn(
            `[workdir-observer] ${paths.length} changed paths exceeds the ${MAX_SNAPSHOT_FILES}-file ` +
                `snapshot ceiling in ${workDir}; fingerprinting the first ${MAX_SNAPSHOT_FILES} and ` +
                `marking the snapshot truncated. A dependency tree is probably untracked because no ` +
                `.gitignore exists yet.`,
        );
    }

    for (const path of paths.slice(0, MAX_SNAPSHOT_FILES)) {
        files.set(path, await fingerprint(join(workDir, path)));
    }

    return { files, truncated, totalPaths: paths.length };
}

async function fingerprint(absolutePath: string): Promise<string> {
    try {
        const info = await stat(absolutePath);
        if (!info.isFile()) return `\0nonfile:${info.mode}`;
        if (info.size > MAX_HASHED_BYTES) return `\0large:${info.size}:${info.mtimeMs}`;
        const content = await readFile(absolutePath);
        return createHash("sha256").update(content).digest("hex");
    } catch {
        // Disappeared between git-status and read (race), or unreadable
        // (broken symlink). A sentinel that differs from "absent", so a path
        // flipping between readable and unreadable counts as a change.
        return "\0unreadable";
    }
}

/**
 * True when the working directory has progressed since the previous
 * snapshot: a new path appeared, a path was removed, or a file's content
 * fingerprint changed.
 *
 * A truncated snapshot on either side returns true. The caller is the nudge,
 * and the nudge is the risky action — injecting advice that may push a working
 * agent off a correct approach. So the closed direction here is "do not
 * nudge": an observation that could not see everything must not be read as
 * proof that nothing happened.
 */
export function hasProgressSince(
    previous: WorkdirSnapshot,
    current: WorkdirSnapshot,
): boolean {
    if (previous.truncated || current.truncated) return true;
    // New or changed file
    for (const [path, hash] of current.files) {
        if (previous.files.get(path) !== hash) return true;
    }
    // Deleted file (path in previous but not in current)
    for (const path of previous.files.keys()) {
        if (!current.files.has(path)) return true;
    }
    return false;
}

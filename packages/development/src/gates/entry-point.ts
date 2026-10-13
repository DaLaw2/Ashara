import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runHostGit, targetRepo } from "../host-git.js";
import type { GateResult } from "./types.js";

// ---------------------------------------------------------------------------
// Entry-point-rewrite check (gate) — E2E Run 7: an agent whole-file-rewrote
// the generated app's src/index.ts to a placeholder, deleting route mounts
// added minutes earlier. Compares the pre-sync entry-point blob against the
// synced file at line level: deletion or wholesale replacement (retention
// below threshold) fails the gate. Deterministic, git-only — no LLM.
// ---------------------------------------------------------------------------

const ENTRY_POINT_REWRITE_MIN_LINES = 10;
const ENTRY_POINT_RETENTION_THRESHOLD = 0.3;

function nonBlankTrimmedLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function countRetainedLines(
  oldLines: readonly string[],
  newLines: readonly string[],
): number {
  const available = new Map<string, number>();
  for (const line of newLines) {
    available.set(line, (available.get(line) ?? 0) + 1);
  }
  let retained = 0;
  for (const line of oldLines) {
    const count = available.get(line) ?? 0;
    if (count > 0) {
      retained++;
      available.set(line, count - 1);
    }
  }
  return retained;
}

export async function checkEntryPointRewrite(
  targetProjectPath: string,
  preSyncHead: string | null,
  contractEntryPoint: string | null = null,
): Promise<GateResult> {
  if (preSyncHead === null) {
    return {
      passed: true,
      output: "entry-point-rewrite check skipped: no pre-sync commit (greenfield project)",
    };
  }

  if (contractEntryPoint === null) {
    return {
      passed: true,
      output: "entry-point-rewrite check skipped: no contract entry point",
    };
  }

  try {
    const { stdout } = await runHostGit(targetRepo(targetProjectPath), ["ls-tree", preSyncHead, "--", contractEntryPoint]);
    const entryPath = stdout.trim().length > 0 ? contractEntryPoint : null;

    if (entryPath === null) {
      return {
        passed: true,
        output:
          "entry-point-rewrite check passed: no entry point existed pre-sync (creation allowed)",
      };
    }

    const { stdout: oldContent } = await runHostGit(targetRepo(targetProjectPath), ["show", `${preSyncHead}:${entryPath}`]);

    let newContent: string;
    try {
      newContent = await readFile(join(targetProjectPath, entryPath), "utf-8");
    } catch {
      return {
        passed: false,
        output:
          `entry-point-rewrite check failed: entry point ${entryPath} existed at pre-sync commit ` +
          `${preSyncHead.slice(0, 12)} but is missing after the sync. The entry point is edit-only: ` +
          "edit the entry point, do not delete or rewrite it.",
      };
    }

    const oldLines = nonBlankTrimmedLines(oldContent);
    const newLines = nonBlankTrimmedLines(newContent);

    if (oldLines.length < ENTRY_POINT_REWRITE_MIN_LINES) {
      return {
        passed: true,
        output:
          `entry-point-rewrite check passed: ${entryPath} had only ${oldLines.length} non-blank ` +
          `line(s) pre-sync (< ${ENTRY_POINT_REWRITE_MIN_LINES}) — heavy edits allowed on small files`,
      };
    }

    const retained = countRetainedLines(oldLines, newLines);
    const retention = retained / oldLines.length;

    if (retention < ENTRY_POINT_RETENTION_THRESHOLD) {
      return {
        passed: false,
        output:
          `entry-point-rewrite check failed: ${entryPath} was rewritten wholesale — only ${retained} of ` +
          `${oldLines.length} pre-sync non-blank line(s) retained (retention ${(retention * 100).toFixed(0)}% ` +
          `< threshold ${ENTRY_POINT_RETENTION_THRESHOLD * 100}%; new file has ${newLines.length} non-blank line(s)). ` +
          "The entry point is edit-only: edit the entry point, do not rewrite it — preserve its " +
          "existing imports and route mounts and apply targeted edits.",
      };
    }

    return {
      passed: true,
      output:
        `entry-point-rewrite check passed: ${entryPath} retained ${retained}/${oldLines.length} ` +
        `pre-sync non-blank line(s) (${(retention * 100).toFixed(0)}%)`,
    };
  } catch (e) {
    // Fail-closed: if git cannot tell us what happened to the entry point,
    // block the sync rather than let a possible rewrite through.
    return {
      passed: false,
      output: `entry-point-rewrite check error (fail-closed): ${String(e).slice(0, 500)}`,
    };
  }
}

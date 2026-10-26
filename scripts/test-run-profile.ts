/**
 * Derives a host's budget profile (test-run-budget.ts BUDGET_PROFILES) from the per-file wall times
 * whole-suite runs on that host recorded (test-run.ts --durations, one JSON line per test file).
 *
 * Usage: npx tsx scripts/test-run-profile.ts <durations file>...
 *
 * Each class's figures are its files' wall times heaviest first, the larger of the runs' for each
 * rank, so no run's slow file is budgeted at another run's fast one; the suite is the largest run's
 * file count and the largest sum of wall times. The output is the profile's `suite` and `classes`,
 * to be checked in with the host and worker counts the runs were measured at.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { describeErrorChain, parseJson } from "@ashara/shared";
import { classOf, type FileClass } from "./test-run-budget.js";

class TestRunProfileError extends Error {
  constructor(
    readonly subject: string,
    readonly reason: string,
  ) {
    super(`test-run-profile: ${subject}: ${reason}`);
    this.name = "TestRunProfileError";
  }
}

const DurationLine = z.strictObject({ path: z.string().min(1), project: z.string().min(1), wallMs: z.number().nonnegative() });
type Duration = z.infer<typeof DurationLine>;

/** How many of a class's heaviest files a profile lists one by one; the rest are budgeted at their mean. */
const LISTED = 10;

/** The per-file wall times one run recorded in `file`, each line validated. */
function readRun(file: string): Duration[] {
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter((line) => line !== "");
  if (lines.length === 0) throw new TestRunProfileError(file, "records no test file");
  return lines.map((line, index) => parseJson(DurationLine, line, `${file}:${index + 1}`));
}

/** Rounded up to a tenth of a second, so a figure is never below what was measured. */
function upToTenth(seconds: number): number {
  return Math.ceil(seconds * 10) / 10;
}

/**
 * The `suite` and `classes` of a profile from `runs`, each the per-file wall times of one
 * whole-suite run on the host.
 * @testseam test-run.test.ts derives a profile from runs of its own
 */
export function profileOf(runs: readonly (readonly Duration[])[]): { suite: { files: number; fileWallS: number }; classes: Record<FileClass, { heaviestS: number[]; restMeanS: number }> } {
  if (runs.length === 0) throw new TestRunProfileError("runs", "a profile needs at least one run's wall times");
  const ranked = (fileClass: FileClass): number[] => {
    const perRun = runs.map((run) => run.filter((file) => classOf(file) === fileClass).map((file) => file.wallMs / 1000).sort((a, b) => b - a));
    const length = Math.max(...perRun.map((seconds) => seconds.length));
    return Array.from({ length }, (_, rank) => Math.max(...perRun.flatMap((seconds) => seconds.slice(rank, rank + 1))));
  };
  const budget = (fileClass: FileClass): { heaviestS: number[]; restMeanS: number } => {
    const seconds = ranked(fileClass);
    if (seconds.length === 0) throw new TestRunProfileError(fileClass, "no run recorded a file of this class, so its figures would be none");
    const rest = seconds.slice(LISTED);
    // A class of no more files than are listed has no rest; its files past the list are budgeted as its lightest.
    const restMeanS = rest.length === 0 ? Math.min(...seconds) : rest.reduce((sum, value) => sum + value, 0) / rest.length;
    return { heaviestS: seconds.slice(0, LISTED).map(upToTenth), restMeanS: upToTenth(restMeanS) };
  };
  const suite = {
    files: Math.max(...runs.map((run) => run.length)),
    fileWallS: Math.ceil(Math.max(...runs.map((run) => run.reduce((sum, file) => sum + file.wallMs, 0))) / 1000),
  };
  return { suite, classes: { podman: budget("podman"), simulator: budget("simulator"), other: budget("other") } };
}

function main(): void {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new TestRunProfileError("arguments", "usage: test-run-profile.ts <durations file>...");
  console.log(JSON.stringify(profileOf(files.map(readRun)), null, 2));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(main)
    .then(undefined, (error: unknown) => {
      console.error(describeErrorChain(error));
      process.exitCode = 1;
    });
}

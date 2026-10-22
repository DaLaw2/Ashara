import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { analysisDigest, trustRecordMain } from "./trust-record.js";
import { clopperPearsonUpper, mcnemarExactOneSided, summarizeArm } from "./trust-stats.js";
import { type PairRow, readTrustLedger } from "./trust-ledger.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COMMIT = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const SEED = "c".repeat(64);
const AT = "2030-01-01T00:00:00Z";
const GUARANTEES = ["G1", "G2", "G3", "G4", "G5"];

function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8", env: gitEnv() });
}

type Row = Record<string, unknown>;

function prereg(analysis: string): Row {
  return {
    kind: "prereg",
    stage: "s1",
    preregDigest: DIGEST,
    commit: COMMIT,
    modelsDigest: DIGEST,
    suiteDigests: { T1: DIGEST, T2: DIGEST },
    intendedDigests: { T1: DIGEST, T2: DIGEST },
    analysisDigest: analysis,
    regressionTenders: [],
    bars: null,
    createdAt: AT,
  };
}

function mappings(run: string, arm: string): Row[] {
  return [
    { kind: "mapping", run, arm, reader: "A", readerRole: "in-house", fileDigest: DIGEST, createdAt: AT },
    { kind: "mapping", run, arm, reader: "B", readerRole: "outside", fileDigest: DIGEST, createdAt: AT },
  ];
}

interface PairOptions {
  readonly reported?: "pass" | "fail" | "unjudged" | "not-reported";
  readonly hidden?: "pass" | "fail" | "unjudged";
  readonly runOutcome?: "terminal" | "sprint0-failed" | "no-report";
}

function pair(run: string, arm: string, tender: string, intended: string, options: PairOptions = {}): Row {
  const reported = options.reported ?? "fail";
  const hidden = options.hidden ?? "pass";
  return {
    kind: "pair",
    stage: "s1",
    run,
    arm,
    tender,
    stack: tender === "T1" ? "rust" : "php",
    tenderKind: "cli",
    seed: SEED,
    commit: COMMIT,
    intended,
    intendedSource: "in-house",
    custody: "in-house hidden",
    mapped: { to: "item-1", narrowed: false, agreed: true },
    reported: { verdict: reported, evidence: reported === "not-reported" ? null : "executed", basis: null },
    hidden: { verdict: hidden, adequacyGated: true, suiteDefect: false, reason: hidden === "unjudged" ? "timed out" : null },
    observation: "output",
    firstDraft: null,
    spend: { claudeUsd: 1, deepseekUsd: 0.1 },
    runOutcome: options.runOutcome ?? "terminal",
    createdAt: AT,
  };
}

/** A whole run of one arm: its two mappings, then one pair per intended guarantee. */
function run(label: string, arm: string, tender: string, options: PairOptions = {}): Row[] {
  return [...mappings(label, arm), ...GUARANTEES.map((intended) => pair(label, arm, tender, intended, options))];
}

function numbered(rows: readonly Row[]): Row[] {
  return rows.map((row, index) => ({ ...row, seq: index + 1 }));
}

function jsonl(rows: readonly Row[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

let work: string;
let repo: string;
let errors: string[];

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "trust-record-test-"));
  repo = path.join(work, "repo");
  await mkdir(path.join(repo, "docs"), { recursive: true });
  await mkdir(path.join(repo, "private"), { recursive: true });
  await writeFile(path.join(repo, ".gitignore"), "private/\ndocs/\n");
  await writeFile(path.join(repo, "docs", "state.toml"), "# board\n");
  git(repo, ["init", "-q"]);
  git(repo, ["add", ".gitignore"]);
  git(repo, ["commit", "-q", "-m", "fixture start"]);
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(work, { recursive: true, force: true });
});

async function record(rows: readonly Row[], out = path.join(work, "record.md")): Promise<{ status: number; page: string }> {
  const ledger = path.join(work, "ledger.jsonl");
  await writeFile(ledger, jsonl(rows));
  const status = await trustRecordMain(["--ledger", ledger, "--out", out, "--repo", repo], {});
  const page = status === 0 ? await readFile(out, "utf8") : "";
  return { status, page };
}

async function baseRows(): Promise<Row[]> {
  return [prereg(await analysisDigest()), ...run("ra1", "ashara", "T1"), ...run("rb1", "baseline", "T1"), ...run("ra2", "ashara", "T2"), ...run("rb2", "baseline", "T2")];
}

describe("exact bounds", () => {
  test.each([
    [0, 7, "0.348"],
    [0, 30, "0.095"],
    [0, 42, "0.069"],
    [1, 10, "0.394"],
    [3, 20, "0.344"],
  ])("the one-sided upper bound for %i of %i is %s", (x, n, expected) => {
    expect(clopperPearsonUpper(x, n).toFixed(3)).toBe(expected);
  });

  test("every event observed or no trial at all leaves the bound at one", () => {
    expect(clopperPearsonUpper(4, 4)).toBe(1);
    expect(clopperPearsonUpper(0, 0)).toBe(1);
  });

  test.each([
    [0, 5, 0.03125],
    [1, 7, 0.03515625],
    [2, 2, 0.6875],
    [0, 0, 1],
    [5, 0, 1],
  ])("the exact one-sided McNemar p for %i against %i discordant is %f", (first, second, expected) => {
    expect(mcnemarExactOneSided(first, second)).toBeCloseTo(expected, 12);
  });
});

describe("the record", () => {
  test("one planted false pass moves the false-confirm count by one and raises its bound", async () => {
    const clean = numbered(await baseRows());
    const planted = clean.map((row) => (row["run"] === "ra1" && row["intended"] === "G3" ? { ...row, ...pair("ra1", "ashara", "T1", "G3", { reported: "pass", hidden: "fail" }), seq: row["seq"] } : row));
    const asPairs = async (rows: readonly Row[]): Promise<readonly PairRow[]> => {
      const file = path.join(work, "parsed.jsonl");
      await writeFile(file, jsonl(rows));
      return (await readTrustLedger(file)).pairs;
    };
    const before = summarizeArm("ashara", await asPairs(clean)).falseConfirm;
    const after = summarizeArm("ashara", await asPairs(planted)).falseConfirm;
    expect(after.events).toBe(before.events + 1);
    expect(after.trials).toBe(before.trials);
    expect(after.upper).toBeGreaterThan(before.upper);
    const cleanPage = await record(clean);
    const plantedPage = await record(planted);
    expect(cleanPage.status).toBe(0);
    expect(plantedPage.status).toBe(0);
    expect(cleanPage.page).toContain("false-confirm rate: 0 of 10 (0.0%), one-sided 95% upper bound 0.259");
    expect(plantedPage.page).toContain("false-confirm rate: 1 of 10 (10.0%), one-sided 95% upper bound 0.394");
    expect(plantedPage.page).toMatch(/STOP-HONESTY: triggered\. 1 Ashara false confirm\(s\) .*\(ledger seq /);
    expect(plantedPage.page).not.toContain("G3");
  });

  test("a run that posted no report keeps every intended guarantee in the denominator", async () => {
    const rows = numbered([prereg(await analysisDigest()), ...run("ra1", "ashara", "T1"), ...run("ra2", "ashara", "T2", { reported: "not-reported", runOutcome: "no-report" })]);
    const { status, page } = await record(rows);
    expect(status).toBe(0);
    expect(page).toContain("false-confirm rate: 0 of 10 ");
    expect(page).toContain("| missed-confirm | 10 |");
  });

  test("a guarantee the hidden suite left unjudged, ungated or defective is no false-confirm trial", async () => {
    const hiddenOf = (intended: unknown): Row => {
      if (intended === "G1") return { verdict: "unjudged", adequacyGated: true, suiteDefect: false, reason: "suite timed out" };
      if (intended === "G2") return { verdict: "fail", adequacyGated: false, suiteDefect: false, reason: null };
      if (intended === "G3") return { verdict: "fail", adequacyGated: true, suiteDefect: true, reason: null };
      return { verdict: "pass", adequacyGated: true, suiteDefect: false, reason: null };
    };
    const unjudged = (rows: readonly Row[]): Row[] =>
      rows.map((row) => (row["kind"] === "pair" ? { ...row, reported: { verdict: "pass", evidence: "executed", basis: null }, hidden: { verdict: "unjudged", adequacyGated: false, suiteDefect: false, reason: "suite timed out" } } : row));
    const none = await record(numbered([prereg(await analysisDigest()), ...unjudged([...run("ra1", "ashara", "T1"), ...run("ra2", "ashara", "T2")])]));
    expect(none.status).toBe(0);
    expect(none.page).toContain("false-confirm rate: 0 of 0 (no trials), one-sided 95% upper bound 1.000");
    expect(none.page).toContain("pairs outside its denominator (hidden unjudged, not adequacy-gated or suite defect): 10");
    const mixed = numbered([prereg(await analysisDigest()), ...run("ra1", "ashara", "T1").map((row) => (row["kind"] === "pair" ? { ...row, reported: { verdict: "pass", evidence: "executed", basis: null }, hidden: hiddenOf(row["intended"]) } : row))]);
    const { status, page } = await record(mixed);
    expect(status).toBe(0);
    expect(page).toContain("false-confirm rate: 0 of 2 (0.0%)");
    expect(page).toContain("| rust | 0 of 2 (0.0%)");
    expect(page).toContain("pairs outside its denominator (hidden unjudged, not adequacy-gated or suite defect): 3");
  });

  test("a run that failed Sprint 0 leaves the false-confirm denominator and counts in delivery", async () => {
    const rows = numbered([prereg(await analysisDigest()), ...run("ra1", "ashara", "T1"), ...run("ra2", "ashara", "T2", { reported: "not-reported", runOutcome: "sprint0-failed" })]);
    const { status, page } = await record(rows);
    expect(status).toBe(0);
    expect(page).toContain("false-confirm rate: 0 of 5 ");
    expect(page).toContain("| ashara | php | 1 | 0 | 1 | 0 |");
  });

  test("an unjudged guarantee beside a real fail leaves the run's hidden overall fail, so the rig rule stays clear", async () => {
    const hiddenFor = (intended: unknown, unjudgedOnly: boolean): "pass" | "fail" | "unjudged" => {
      if (intended === "G2") return "unjudged";
      return intended === "G1" && !unjudgedOnly ? "fail" : "pass";
    };
    const withVerdicts = (rows: readonly Row[], unjudgedOnly: boolean): Row[] =>
      rows.map((row) => (row["kind"] === "pair" ? { ...row, hidden: { verdict: hiddenFor(row["intended"], unjudgedOnly), adequacyGated: true, suiteDefect: false, reason: hiddenFor(row["intended"], unjudgedOnly) === "unjudged" ? "no libc fsync to intercept" : null } } : row));
    const runs = [...run("ra1", "ashara", "T1"), ...run("rb1", "baseline", "T1"), ...run("ra2", "ashara", "T2")];
    const failing = await record(numbered([prereg(await analysisDigest()), ...withVerdicts(runs, false)]));
    expect(failing.status).toBe(0);
    expect(failing.page).toContain("- STOP-INFRA: clear. 0 hidden verdict(s) incomplete");
    const incomplete = await record(numbered([prereg(await analysisDigest()), ...withVerdicts(runs, true)]));
    expect(incomplete.status).toBe(0);
    expect(incomplete.page).toContain("- STOP-INFRA: triggered. 3 hidden verdict(s) incomplete");
  });

  test("a tender whose run label a commit message cites moves to the regression column", async () => {
    await writeFile(path.join(repo, "fix.txt"), "fix\n");
    git(repo, ["add", "fix.txt"]);
    git(repo, ["commit", "-q", "-m", "Fix the WAL found by run ra2"]);
    const { status, page } = await record(numbered(await baseRows()));
    expect(status).toBe(0);
    expect(page).toContain("Regression column: T2");
    expect(page).toContain("### Regression: ashara");
  });
});

describe("refusals", () => {
  test("a row with a missing field exits 1 naming its seq", async () => {
    const rows = numbered(await baseRows()).map((row) => {
      if (row["seq"] !== 5) return row;
      const { observation: _dropped, ...rest } = row;
      return rest;
    });
    expect((await record(rows)).status).toBe(1);
    expect(errors.join("\n")).toMatch(/seq 5 \(line 5\): observation:/);
  });

  test("a gap in seq exits 1", async () => {
    const rows = numbered(await baseRows()).filter((row) => row["seq"] !== 7);
    expect((await record(rows)).status).toBe(1);
    expect(errors.join("\n")).toContain("seq 8: seq follows 6");
  });

  test("a pair row before the two mapping rows of its run exits 1", async () => {
    const rows = numbered([prereg(await analysisDigest()), mappings("ra1", "ashara")[0] ?? {}, pair("ra1", "ashara", "T1", "G1"), mappings("ra1", "ashara")[1] ?? {}]);
    expect((await record(rows)).status).toBe(1);
    expect(errors.join("\n")).toContain("seq 3: run ra1 arm ashara lacks two earlier mapping rows");
  });

  test("an analysis digest other than the scripts' exits 1", async () => {
    const rows = numbered([prereg(DIGEST), ...run("ra1", "ashara", "T1")]);
    expect((await record(rows)).status).toBe(1);
    expect(errors.join("\n")).toContain("pre-registered analysis");
  });

  test("--out inside a git work tree that does not ignore it exits 2 and writes nothing", async () => {
    const out = path.join(repo, "record.md");
    expect((await record(numbered(await baseRows()), out)).status).toBe(2);
    await expect(readFile(out, "utf8")).rejects.toThrow(/ENOENT/);
  });

  test("--out at a path the work tree ignores is written", async () => {
    expect((await record(numbered(await baseRows()), path.join(repo, "private", "record.md"))).status).toBe(0);
  });
});

describe("no builder package names the ledger", () => {
  test("neither the builder packages nor the trust modules name the hidden directory or the ledger tools", () => {
    const hidden = ["ashara", "hidden"].join("-");
    const ledgerDir = ["trust", "ledger"].join("/");
    const grep = (args: readonly string[]): string => {
      try {
        return execFileSync("git", ["-C", REPO_ROOT, "grep", "--untracked", "-n", ...args], { encoding: "utf8", env: gitEnv() });
      } catch (err) {
        if (err instanceof Error && "status" in err && err.status === 1) return "";
        throw err;
      }
    };
    expect(grep(["-e", hidden, "--", "packages/evaluation/src/trust-*"])).toBe("");
    expect(grep(["-e", `${hidden}/`, "-e", ledgerDir, "--", "packages"])).toBe("");
    expect(grep(["-e", "trust-record", "-e", "trust-ledger", "-e", "trust-stats", "--", "packages", ":!packages/evaluation"])).toBe("");
  });
});

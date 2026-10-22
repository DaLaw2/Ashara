import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { pickTender, readLedger, readPool, recordedPick, type PickRecord } from "./pool-selection.js";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const SCRIPT = path.join(REPO, "scripts", "pool-select.ts");
const COMMIT = "0e2adaf991d6c272b39d4896560d4d873a1f2950";

// A throwaway pool: the ids and shape of a real pool.toml, no suite and no canary.
const POOL_TOML = `version = 1

[[tender]]
id = "A"
name = "Alpha"
dir = "A-alpha"

[[tender]]
id = "B"
name = "Beta"
dir = "B-beta"

[[tender]]
id = "C"
name = "Gamma"
dir = "C-gamma"
`;

function line(run: string, tender: string): string {
  const record: PickRecord = { kind: "pick", run, commit: COMMIT, tender, seed: "d".repeat(64), reason: "fewest runs (0) among A, B, C; drawn by seed", at: "2026-10-18T00:00:00.000Z" };
  return `${JSON.stringify(record)}\n`;
}

function select(dir: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env["ASHARA_TENDER_POOL"];
  return spawnSync(process.execPath, [TSX, SCRIPT, "--pool", dir, ...args], { encoding: "utf8", env, timeout: 60_000 });
}

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pool-select-"));
  await writeFile(path.join(dir, "pool.toml"), POOL_TOML);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("pickTender", () => {
  test("picks the tender with the fewest runs in the ledger", async () => {
    await writeFile(path.join(dir, "ledger.jsonl"), line("r1", "A") + line("r2", "B") + line("r3", "A") + line("r4", "C") + line("r5", "B"));
    const pick = pickTender(await readPool(dir), await readLedger(dir), { run: "r6", commit: COMMIT, at: "t" });
    expect(pick.tender).toBe("C");
    expect(pick.reason).toBe("fewest runs (1) among C; drawn by seed");
  });

  test("a tie is drawn by seed = sha256(run label + commit): the same run and commit give the same pick", async () => {
    await writeFile(path.join(dir, "ledger.jsonl"), line("r1", "A"));
    const pool = await readPool(dir);
    const ledger = await readLedger(dir);
    const seed = createHash("sha256").update(`r2${COMMIT}`).digest("hex");
    const first = pickTender(pool, ledger, { run: "r2", commit: COMMIT, at: "t" });
    expect(first.seed).toBe(seed);
    expect(first.tender).toBe(["B", "C"][Number(BigInt(`0x${seed}`) % 2n)]);
    expect(pickTender(pool, ledger, { run: "r2", commit: COMMIT, at: "t2" }).tender).toBe(first.tender);
    const draws = new Set(Array.from({ length: 40 }, (_, i) => pickTender(pool, ledger, { run: `x${i}`, commit: COMMIT, at: "t" }).tender));
    expect(draws).toEqual(new Set(["B", "C"]));
  });

  test("a pinned pick takes its tender and records its reason", async () => {
    await writeFile(path.join(dir, "ledger.jsonl"), "");
    const pick = pickTender(await readPool(dir), await readLedger(dir), { run: "r1", commit: COMMIT, at: "t", pin: { tender: "B", reason: "re-run on the WAL defect" } });
    expect(pick).toMatchObject({ tender: "B", reason: "pinned: re-run on the WAL defect" });
    expect(() => pickTender([{ id: "B", name: "b", dir: "b" }], [], { run: "r1", commit: COMMIT, at: "t", pin: { tender: "Z", reason: "x" } })).toThrow(/the pinned tender "Z" is not in the pool/);
  });

  test("a run label already in the ledger is refused, never picked twice", async () => {
    await writeFile(path.join(dir, "ledger.jsonl"), line("r1", "A"));
    expect(() => pickTender([{ id: "A", name: "a", dir: "a" }], [{ kind: "pick", run: "r1", commit: COMMIT, tender: "A", seed: "d".repeat(64), reason: "x", at: "t" }], { run: "r1", commit: COMMIT, at: "t" })).toThrow(
      /already picked A/,
    );
  });
});

describe("pool-select appends the pick and fails closed", () => {
  test("the pick line (tender, seed, reason) is appended to the ledger and read back by its run label", async () => {
    await writeFile(path.join(dir, "ledger.jsonl"), line("r1", "A") + line("r2", "B"));
    const result = select(dir, "--run", "r3", "--commit", COMMIT);
    expect(result.status, result.stderr).toBe(0);
    const seed = createHash("sha256").update(`r3${COMMIT}`).digest("hex");
    expect(result.stdout).toContain(`tender C seed ${seed} (fewest runs (0) among C; drawn by seed)`);
    expect(result.stdout).toContain(`vision text: ${path.join(dir, "C-gamma", "vision.txt")}`);
    const lines = (await readFile(path.join(dir, "ledger.jsonl"), "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(await recordedPick(dir, "r3")).toMatchObject({ run: "r3", commit: COMMIT, tender: "C", seed, reason: "fewest runs (0) among C; drawn by seed" });
  });

  test("a pinned run records pinned with its reason in the ledger", async () => {
    await writeFile(path.join(dir, "ledger.jsonl"), "");
    const result = select(dir, "--run", "r1", "--commit", COMMIT, "--pin", "A", "--reason", "aimed at one defect");
    expect(result.status, result.stderr).toBe(0);
    expect(await recordedPick(dir, "r1")).toMatchObject({ tender: "A", reason: "pinned: aimed at one defect" });
  });

  test("a missing ledger fails closed: no pick, no ledger created", async () => {
    const result = select(dir, "--run", "r1", "--commit", COMMIT);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the ledger cannot be read");
    await expect(readLedger(dir)).rejects.toThrow(/the ledger cannot be read/);
  });

  test("an invalid ledger line fails closed and the ledger is left as it was", async () => {
    const text = `${line("r1", "A")}{"kind":"pick","run":"r2"}\n`;
    await writeFile(path.join(dir, "ledger.jsonl"), text);
    const result = select(dir, "--run", "r3", "--commit", COMMIT);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("line 2");
    expect(await readFile(path.join(dir, "ledger.jsonl"), "utf8")).toBe(text);
  });

  test("a missing pool, and a pool with no tender, fail closed", async () => {
    await writeFile(path.join(dir, "ledger.jsonl"), "");
    await writeFile(path.join(dir, "pool.toml"), "version = 1\ntender = []\n");
    const empty = select(dir, "--run", "r1", "--commit", COMMIT);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("the pool names no tender");
    await rm(path.join(dir, "pool.toml"));
    const missing = select(dir, "--run", "r1", "--commit", COMMIT);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("pool.toml");
    expect(await readFile(path.join(dir, "ledger.jsonl"), "utf8")).toBe("");
  });

  test("no --pool and no ASHARA_TENDER_POOL is a refusal, never a path in the repository", () => {
    const env = { ...process.env };
    delete env["ASHARA_TENDER_POOL"];
    const result = spawnSync(process.execPath, [TSX, SCRIPT, "--run", "r1", "--commit", COMMIT], { encoding: "utf8", env, timeout: 60_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("neither is set");
  });
});

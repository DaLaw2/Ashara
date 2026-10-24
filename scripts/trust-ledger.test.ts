import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { ClientRepository, createDb, ProjectRepository, resolveTestDatabaseUrl } from "@ashara/db";
import type { Database } from "@ashara/db";
import { type AppendOptions, appendRun, LedgerPathRefused, MappingDigestMismatch, PoolMappingRefused, readTrustLedger } from "@ashara/evaluation";
import { parseProjectId, type ProjectId } from "@ashara/shared";

// A run's Ashara arm appended to a fixture ledger in a temp directory, its guarantee_verdicts and llm_calls scripted
// into the test database under a project this suite creates and deletes. Packet item-1 is guarantee G1 (pass),
// item-2 G2 (fail) and item-3 G3 (pass), which no reader maps to an intended guarantee: an omission dressed as delivery.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `trust-ledger-test-${randomUUID().slice(0, 8)}`;
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COMMIT = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const SEED = "c".repeat(64);
const RUN = "r1";

type Db = Database;
let db: Db;
let projectId: ProjectId;
let work: string;

const idRows = z.array(z.object({ id: z.string() })).length(1);

async function insertedId(statement: ReturnType<typeof sql>): Promise<string> {
  const [row] = idRows.parse((await db.execute(statement)).rows);
  if (row === undefined) throw new Error("the insert returned no row");
  return row.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  const client = await new ClientRepository(db).create(NAME);
  projectId = parseProjectId((await new ProjectRepository(db).create(NAME, client.id)).id, "fixture project");
  // The sweep's delivered report: the project's last terminal report.
  const reportId = await insertedId(sql`
    INSERT INTO client_messages (project_id, direction, kind, body) VALUES (${projectId}, 'outbound', 'report', 'scripted report')
    RETURNING id`);
  const sweepId = await insertedId(sql`
    INSERT INTO acceptance_sweeps (project_id, main_commit, environment_version, checked_tasks, unchecked_tasks, passed, details, check_outcomes)
    VALUES (${projectId}, ${COMMIT}, 'v1', '[]'::jsonb, '[]'::jsonb, true, 'scripted sweep', '[]'::jsonb)
    RETURNING id`);
  await db.execute(sql`INSERT INTO told_reports (subject_kind, subject_id, project_id, report_id) VALUES ('delivered', ${sweepId}, ${projectId}, ${reportId})`);
  for (const [guarantee, verdict, evidence] of [
    ["G1", "pass", "witness"],
    ["G2", "fail", "witness"],
    ["G3", "pass", "implementer-visible"],
  ] as const) {
    await db.execute(sql`
      INSERT INTO guarantee_verdicts (project_id, report_id, sweep_id, vision_version, guarantee_id, verdict, reason, basis, evidence_class)
      VALUES (${projectId}, ${reportId}, ${sweepId}, 1, ${guarantee}, ${verdict}, NULL, 'client-stated', ${evidence})`);
  }
  for (const [provider, cost] of [
    ["anthropic", 0.5],
    ["deepseek", 0.25],
  ] as const) {
    await db.execute(sql`
      INSERT INTO llm_calls (project_id, call_site, provider, model, cost_usd, estimated_cost_usd, outcome, finish_reason, state)
      VALUES (${projectId}, 'agent-runner', ${provider}, 'scripted', ${cost}, 1, 'ok', 'stop', 'recorded')`);
  }
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM guarantee_verdicts WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM acceptance_sweeps WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE name = ${NAME}`);
  await db.$client.end();
});

function mappingToml(narrowedI2: boolean): string {
  return [
    "version = 1",
    `run = "${RUN}"`,
    `packet = "${DIGEST}"`,
    "",
    "[[map]]",
    'intended = "I1"',
    'to = ["item-1"]',
    "narrowed = false",
    "",
    "[[map]]",
    'intended = "I2"',
    'to = ["item-2"]',
    `narrowed = ${narrowedI2}`,
    "",
    "[[map]]",
    'intended = "I3"',
    "to = []",
    "narrowed = false",
    "",
  ].join("\n");
}

function hiddenGuarantee(id: string, verdict: "pass" | "fail") {
  return { id, verdict, cases: 1, failed: verdict === "fail" ? 1 : 0 };
}

function factOf(id: string) {
  return { id, observation: "output", adequacyGated: true, suiteDefect: false, firstDraft: null };
}

function file(name: string): string {
  return path.join(work, name);
}

function options(overrides: Partial<AppendOptions> = {}): AppendOptions {
  return {
    ledger: file("ledger.jsonl"),
    projectId,
    run: RUN,
    poolDir: file("pool"),
    facts: file("facts.json"),
    mappingA: file("reader-a.toml"),
    mappingB: file("reader-b.toml"),
    key: file("key.json"),
    hidden: null,
    now: new Date("2030-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "trust-ledger-test-"));
  await mkdir(file("pool"));
  const pick = { kind: "pick", run: RUN, commit: COMMIT, tender: "T1", seed: SEED, reason: "drawn by seed", at: "2030-01-01T00:00:00Z" };
  await writeFile(path.join(file("pool"), "ledger.jsonl"), `${JSON.stringify(pick)}\n`);
  const prereg = {
    kind: "prereg",
    seq: 1,
    stage: "s1",
    preregDigest: DIGEST,
    commit: COMMIT,
    modelsDigest: DIGEST,
    suiteDigests: { T1: DIGEST },
    intendedDigests: { T1: DIGEST },
    analysisDigest: DIGEST,
    regressionTenders: [],
    bars: null,
    createdAt: "2030-01-01T00:00:00Z",
  };
  await writeFile(file("ledger.jsonl"), `${JSON.stringify(prereg)}\n`);
  const items = [
    { label: "item-1", id: "G1" },
    { label: "item-2", id: "G2" },
    { label: "item-3", id: "G3" },
  ];
  await writeFile(file("key.json"), JSON.stringify({ version: 1, run: RUN, arm: "ashara", items }));
  await writeFile(file("reader-a.toml"), mappingToml(false));
  await writeFile(file("reader-b.toml"), mappingToml(true));
  const facts = {
    version: 1,
    run: RUN,
    stage: "s1",
    stack: "fixture-stack",
    tenderKind: "cli",
    intendedSource: "in-house",
    custody: "in-house hidden",
    runOutcome: "terminal",
    intended: ["I1", "I2", "I3"].map(factOf),
  };
  await writeFile(file("facts.json"), JSON.stringify(facts));
  const hidden = {
    tender: "T1",
    suiteDigest: DIGEST,
    product: { dir: "/product", digest: DIGEST },
    image: "fixture-image",
    suiteArgs: [],
    timeoutSeconds: 60,
    startedAt: "2030-01-01T00:00:00Z",
    endedAt: "2030-01-01T00:01:00Z",
    overall: "fail",
    guarantees: [hiddenGuarantee("I1", "pass"), hiddenGuarantee("I2", "fail"), hiddenGuarantee("I3", "fail")],
    problems: [],
    runs: {},
  };
  await writeFile(file("hidden.json"), JSON.stringify(hidden));
});

const HOME = process.env["HOME"];

afterEach(async () => {
  if (HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = HOME;
  await rm(work, { recursive: true, force: true });
});

/** A home directory in the test's temp dir, so no test resolves or touches the operator's own hidden directory. */
async function tempHome(name: string): Promise<string> {
  const home = file(name);
  await mkdir(home);
  return realpathSync(home);
}

const HIDDEN = `.${["ashara", "hidden"].join("-")}`;

async function sha256Of(name: string): Promise<string> {
  return createHash("sha256").update(await readFile(name)).digest("hex");
}

async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("the append was not refused");
}

describe("trust-ledger append", () => {
  test("the mapping rows, then the pair rows, are appended and read back through the ledger reader", async () => {
    expect(await appendRun(db, options())).toBe(2);
    expect(await appendRun(db, options({ hidden: file("hidden.json") }))).toBe(3);

    const ledger = await readTrustLedger(file("ledger.jsonl"));
    expect(ledger.mappings.map((row) => [row.seq, row.reader, row.readerRole])).toEqual([
      [2, "A", "in-house"],
      [3, "B", "outside"],
    ]);
    const pairs = new Map(ledger.pairs.map((row) => [row.intended, row]));
    expect(pairs.get("I1")).toMatchObject({
      seq: 4,
      tender: "T1",
      seed: SEED,
      mapped: { to: "G1", narrowed: false, agreed: true },
      reported: { verdict: "pass", evidence: "witness" },
      hidden: { verdict: "pass" },
      spend: { claudeUsd: 0.5, deepseekUsd: 0.25 },
    });
    expect(pairs.get("I2")).toMatchObject({ mapped: { to: "G2", narrowed: true, agreed: false }, reported: { verdict: "fail" }, hidden: { verdict: "fail" } });
    expect(pairs.get("I3")).toMatchObject({ mapped: { to: null }, reported: { verdict: "pass", evidence: "implementer-visible" }, hidden: { verdict: "fail" } });
  });

  test("appending the same run again appends nothing", async () => {
    await appendRun(db, options({ hidden: file("hidden.json") }));
    const once = await readFile(file("ledger.jsonl"), "utf8");

    expect(await appendRun(db, options({ hidden: file("hidden.json") }))).toBe(0);

    expect(await readFile(file("ledger.jsonl"), "utf8")).toBe(once);
  });

  test("a mapping file whose digest is not its ledger row's is refused", async () => {
    await appendRun(db, options());
    await writeFile(file("reader-b.toml"), mappingToml(false));

    await expect(appendRun(db, options({ hidden: file("hidden.json") }))).rejects.toThrow(MappingDigestMismatch);
  });

  test("a ledger path inside a git work tree is refused before anything is read, the refusal naming the trust ledger", async () => {
    const inside = path.join(REPO_ROOT, "scripts", `trust-ledger-test-${randomUUID().slice(0, 8)}.jsonl`);

    const refusal = await refusalOf(appendRun(db, options({ ledger: inside })));

    expect(refusal).toBeInstanceOf(PoolMappingRefused);
    expect(refusal instanceof Error ? refusal.message : "").toMatch(/the trust ledger ".*", resolved to .*, is inside the git work tree .*; keep the trust ledger outside every work tree/);
  });

  test("a ledger symlinked into a git work tree is refused on its resolved path, and the ledger is untouched", async () => {
    const tree = file("tree");
    await mkdir(tree);
    expect(spawnSync("git", ["init", "-q", tree], { encoding: "utf8" }).status).toBe(0);
    const real = path.join(tree, "ledger.jsonl");
    await writeFile(real, await readFile(file("ledger.jsonl")));
    await symlink(real, file("linked.jsonl"));
    const before = await sha256Of(real);

    await expect(appendRun(db, options({ ledger: file("linked.jsonl") }))).rejects.toThrow(PoolMappingRefused);

    expect(await sha256Of(real)).toBe(before);
  });

  test("a ledger under the hidden directory of a symlinked home is refused", async () => {
    const home = await tempHome("home");
    await mkdir(path.join(home, HIDDEN));
    await symlink(home, file("home-link"));
    process.env["HOME"] = file("home-link");

    await expect(appendRun(db, options({ ledger: path.join(home, HIDDEN, "ledger.jsonl") }))).rejects.toThrow(LedgerPathRefused);
  });

  test("a ledger in the directory the hidden directory links to is refused", async () => {
    const home = await tempHome("home");
    const target = await tempHome("hidden-target");
    await symlink(target, path.join(home, HIDDEN));
    process.env["HOME"] = home;

    await expect(appendRun(db, options({ ledger: path.join(target, "ledger.jsonl") }))).rejects.toThrow(LedgerPathRefused);
  });

  test("the refusal under the hidden directory states the path it compared and the directory it compared against", async () => {
    const home = await tempHome("home");
    process.env["HOME"] = home;
    const ledger = path.join(home, HIDDEN, "nested", "ledger.jsonl");

    const refusal = await refusalOf(appendRun(db, options({ ledger })));

    expect(refusal).toBeInstanceOf(LedgerPathRefused);
    expect(refusal instanceof Error ? refusal.message : "").toBe(
      `trust-ledger append: the ledger ${JSON.stringify(ledger)} is refused: its path ${JSON.stringify(ledger)} is ${JSON.stringify(path.join(home, HIDDEN))}, ` +
        "the hidden directory of the home directory, or lies under it; keep the ledger outside it",
    );
  });

  test("a pair row that fails the row schema is refused and leaves the ledger byte-identical", async () => {
    // A pick's commit may be any 7 to 64 hex digits; a pair row records a full 40-digit commit only.
    const pick = { kind: "pick", run: RUN, commit: "a".repeat(12), tender: "T1", seed: SEED, reason: "drawn by seed", at: "2030-01-01T00:00:00Z" };
    await writeFile(path.join(file("pool"), "ledger.jsonl"), `${JSON.stringify(pick)}\n`);
    const before = await sha256Of(file("ledger.jsonl"));

    await expect(appendRun(db, options({ hidden: file("hidden.json") }))).rejects.toThrow(/commit: a commit is a full 40-digit lowercase hex sha/);

    expect(await sha256Of(file("ledger.jsonl"))).toBe(before);
  });
});

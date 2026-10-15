import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createProjectWithTender } from "@ashara/engagement";
import { ClientRepository, DEFAULT_DATABASE_URL, SecretRepository, createDb, createPgPool } from "@ashara/db";
import type { PoolFactory } from "@ashara/db";
import type { GitRunner, ProcessRunner } from "@ashara/execution-infra";
import { NoLLMProvidersConfigured } from "@ashara/model-access";
import type { LanguageModelFactory } from "@ashara/model-access";
import { API_TOKEN_SECRET_NAME, SecretStore, createKeyFile, loadMasterKey, providerApiKeySecretName } from "@ashara/security";
import type { MasterKey } from "@ashara/security";
import { composeAshara } from "@ashara/server/compose";
import { createIntakeStore } from "@ashara/server/intake-store";
import { systemClock } from "@ashara/shared";
import { createRunDatabase, prepareTemplate } from "../simulator/database.js";
import type { RunDatabase } from "../simulator/database.js";
import { projectState } from "../simulator/project-state.js";

// c-liaison-intake C3: a gateway that cannot be built stops intake with a typed error and no
// constant alignment is produced. The gateway is built once, in composeAshara, before the core
// loop or the HTTP app exist, so the stop is the process refusing to compose: a tender already on
// record stays open and untouched for the process that can build a gateway. Each test runs on its
// own database made from the simulator's migrated template, so its secret store holds only the
// keys the test puts there. No model, podman or git call is made: every such port refuses.

const BASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const ENV_KEYS = ["WORKDIR_BASE", "ASHARA_BUDGET_LIMIT_USD", "ASHARA_BUDGET_TOTAL", "ASHARA_PROJECT_BUDGET_LIMIT_USD"] as const;
const TENDER = "Build a booking page for our two pottery studios.";

/** A port composeAshara reached although no gateway could be built. */
class PortReachedWithoutGateway extends Error {
  constructor(readonly port: string) {
    super(`composeAshara called its ${port} port although the gateway could not be built`);
    this.name = "PortReachedWithoutGateway";
  }
}

/** A test step ran outside the database beforeEach made for it. */
class NoTestDatabase extends Error {
  constructor(readonly step: string) {
    super(`${step} ran with no test database`);
    this.name = "NoTestDatabase";
  }
}

const refusingModels: LanguageModelFactory = () => {
  throw new PortReachedWithoutGateway("models");
};
const refusingProcesses: ProcessRunner = () => Promise.reject(new PortReachedWithoutGateway("processRunner"));
const refusingGit: GitRunner = {
  text: () => Promise.reject(new PortReachedWithoutGateway("git.text")),
  bytes: () => Promise.reject(new PortReachedWithoutGateway("git.bytes")),
};

let template = "";
let workdir = "";
let savedEnv = new Map<string, string | undefined>();
let database: RunDatabase | null = null;
let observer: ReturnType<typeof createDb> | null = null;
let masterKey: MasterKey;
let secrets: SecretStore;
/** Pools composeAshara opened; it does not close them when it throws. */
let composedPools: pg.Pool[] = [];

beforeAll(async () => {
  template = await prepareTemplate(BASE_URL);
  workdir = await mkdtemp(join(tmpdir(), "ashara-gateway-unbuildable-"));
  const keyFile = join(workdir, "master.key");
  createKeyFile(keyFile);
  masterKey = loadMasterKey(keyFile);
  savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env["WORKDIR_BASE"] = join(workdir, "work");
  process.env["ASHARA_BUDGET_LIMIT_USD"] = "1";
  delete process.env["ASHARA_BUDGET_TOTAL"];
  delete process.env["ASHARA_PROJECT_BUDGET_LIMIT_USD"];
});

afterAll(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(workdir, { recursive: true, force: true });
});

beforeEach(async () => {
  database = await createRunDatabase(BASE_URL, template, 96);
  observer = createDb(database.url);
  secrets = new SecretStore(new SecretRepository(observer), masterKey);
  // The API token is loaded before the gateway; with it present the first refusal is the gateway's.
  await secrets.put(API_TOKEN_SECRET_NAME, "gateway-unbuildable-api-token");
});

afterEach(async () => {
  await Promise.all(composedPools.map((pool) => pool.end()));
  composedPools = [];
  await observer?.$client.end();
  observer = null;
  await database?.drop();
  database = null;
});

function db(): ReturnType<typeof createDb> {
  if (observer === null) throw new NoTestDatabase("db()");
  return observer;
}

function databaseUrl(): string {
  if (database === null) throw new NoTestDatabase("databaseUrl()");
  return database.url;
}

const trackedPools: PoolFactory = (config) => {
  const pool = createPgPool(config);
  composedPools.push(pool);
  return pool;
};

function compose(url: string) {
  return composeAshara({
    masterKey,
    databaseUrl: url,
    createPool: trackedPools,
    models: refusingModels,
    processRunner: refusingProcesses,
    git: refusingGit,
    clock: systemClock,
    taskLanes: (items, run) => Promise.allSettled(items.map(run)),
  });
}

async function tenderOnRecord(): Promise<{ projectId: string; tenderId: string }> {
  const client = await new ClientRepository(db()).create("gateway-unbuildable-client");
  const created = await createProjectWithTender(db(), client.id, "gateway-unbuildable", TENDER);
  return { projectId: created.project.id, tenderId: created.message.id };
}

const MessageRows = z.array(
  z.object({
    kind: z.string(),
    consumed: z.boolean(),
    intakeAttempts: z.number(),
    intakeLastError: z.string().nullable(),
  }),
);
const CountRow = z.tuple([z.object({ n: z.number() })]);
const ProjectRow = z.tuple([z.object({ status: z.string(), blockedReason: z.string().nullable() })]);

/** What the refused composition left of the project: the tender alone, untouched, and nothing written. */
async function expectUntouched(projectId: string, tenderId: string): Promise<void> {
  const messages = MessageRows.parse(
    (
      await db().execute(sql`
        SELECT kind, consumed_at IS NOT NULL AS consumed, intake_attempts AS "intakeAttempts",
               intake_last_error AS "intakeLastError"
        FROM client_messages WHERE project_id = ${projectId}`)
    ).rows,
  );
  expect(messages).toEqual([{ kind: "tender", consumed: false, intakeAttempts: 0, intakeLastError: null }]);

  const visions = CountRow.parse(
    (await db().execute(sql`SELECT count(*)::int AS n FROM vision_documents WHERE project_id = ${projectId}`)).rows,
  );
  expect(visions[0].n).toBe(0);
  const calls = CountRow.parse(
    (await db().execute(sql`SELECT count(*)::int AS n FROM llm_calls WHERE project_id = ${projectId}`)).rows,
  );
  expect(calls[0].n).toBe(0);
  const project = ProjectRow.parse(
    (await db().execute(sql`SELECT ${projectState} AS status, blocked_reason AS "blockedReason" FROM projects WHERE id = ${projectId}`)).rows,
  );
  expect(project[0].blockedReason).toBeNull();

  // The next process that can build a gateway takes the same tender in.
  const open = await createIntakeStore(db()).openTenders();
  expect(open.map((t) => t.id)).toEqual([tenderId]);
}

describe("c-liaison-intake C3: intake with a gateway that cannot be built", () => {
  test("no provider key in the secret store: composition refuses with NoLLMProvidersConfigured", async () => {
    const { projectId, tenderId } = await tenderOnRecord();

    const refusal = await compose(databaseUrl()).then(
      () => null,
      (err: unknown) => err,
    );

    expect(refusal).toBeInstanceOf(NoLLMProvidersConfigured);
    if (!(refusal instanceof NoLLMProvidersConfigured)) return;
    expect(refusal.checkedSources).toEqual(["secret store provider/<name>/api_key for each provider_configs row"]);
    expect(refusal.howToFix).toContain("scripts/secret.ts put provider/<name>/api_key");
    await expectUntouched(projectId, tenderId);
  });

  test("a keyed provider whose provider_type no adapter serves: composition refuses with InvalidGatewayCatalog", async () => {
    const { projectId, tenderId } = await tenderOnRecord();
    const ProviderRow = z.tuple([z.object({ name: z.string() })]);
    const [provider] = ProviderRow.parse(
      (
        await db().execute(sql`
          UPDATE provider_configs SET provider_type = 'no-such-adapter'
          WHERE name = (SELECT provider_name FROM model_configs ORDER BY model_id LIMIT 1)
          RETURNING name`)
      ).rows,
    );
    await secrets.put(providerApiKeySecretName(provider.name), "gateway-unbuildable-provider-key");

    const refusal = await compose(databaseUrl()).then(
      () => null,
      (err: unknown) => err,
    );

    // The package exports no InvalidGatewayCatalog class, so the refusal is read by its typed shape.
    expect(refusal).toBeInstanceOf(Error);
    const catalogRefusal = z
      .object({ name: z.literal("InvalidGatewayCatalog"), source: z.string(), issues: z.array(z.string()) })
      .parse(refusal);
    expect(catalogRefusal.source).toBe("provider_configs");
    expect(catalogRefusal.issues).toEqual([
      expect.stringContaining(`provider "${provider.name}": provider_type "no-such-adapter" is not one of`),
    ]);
    await expectUntouched(projectId, tenderId);
  });
});

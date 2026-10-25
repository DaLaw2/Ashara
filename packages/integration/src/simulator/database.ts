import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
// eslint-disable-next-line no-restricted-syntax -- real wait: a database stays in use until its sessions end
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { z } from "zod";
import { MIGRATIONS_DIR, runMigrations } from "@ashara/db";
import { describeErrorChain } from "@ashara/shared";

/*
 * Scratch databases: one template migrated once per migration set, one database
 * per run created from it and dropped after, and stale run databases older than an hour dropped
 * at tier start. Never the shared database itself: every name starts with `ashara_sim_`.
 */
// The observer's handle on a run database is db's own handle, read-only by use, never faulted.
export type { Database } from "@ashara/db";

const PREFIX = "ashara_sim_";
const TEMPLATE_PREFIX = `${PREFIX}tpl_`;
const RUN_PREFIX = `${PREFIX}r_`;
const STALE_AFTER_SECONDS = 60 * 60;
/** pg_advisory_lock key serialising template builds and CREATE DATABASE ... TEMPLATE across workers. */
const TEMPLATE_LOCK = 7_402_114;

class ScratchDatabaseFailed extends Error {
  constructor(
    readonly operation: string,
    readonly database: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`scratch database ${database}: ${operation} failed: ${detail}`, options);
    this.name = "ScratchDatabaseFailed";
  }
}

function urlFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withAdmin<T>(baseUrl: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor(baseUrl, "postgres"), application_name: "ashara-sim-admin" });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const nameRows = z.array(z.object({ datname: z.string() }));

async function databaseNames(client: pg.Client, prefix: string): Promise<string[]> {
  const result = await client.query("SELECT datname FROM pg_database WHERE datname LIKE $1", [`${prefix}%`]);
  return nameRows.parse(result.rows).map((row) => row.datname);
}

function quoted(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new ScratchDatabaseFailed("quote", name, "the name is not a plain identifier");
  return `"${name}"`;
}

/** The query a drop needs: pg.Client's, or a stand-in that answers as Postgres would. */
interface AdminQuery {
  query(text: string): Promise<unknown>;
}

/** SQLSTATE object_in_use: a backend on the database had not exited when the drop ran. */
const OBJECT_IN_USE = "55006";
const DROP_ATTEMPTS = 5;
const DROP_PAUSE_MS = 1_000;

const PgErrorCode = z.object({ code: z.string() });

/**
 * Drops a scratch database, ending every session on it first (`WITH (FORCE)`). A terminated backend
 * exits on its own schedule, and on a loaded host it can outlast Postgres's wait inside the drop, so
 * a drop refused as in use is retried a bounded number of times, then fails with the last refusal
 * as its cause. Any other failure is not a slow exit and fails at once.
 * @testseam database.test.ts drives the retry with a stand-in client
 */
export async function dropDatabase(client: AdminQuery, name: string, pauseMs: number = DROP_PAUSE_MS): Promise<void> {
  const statement = `DROP DATABASE IF EXISTS ${quoted(name)} WITH (FORCE)`;
  let refusal: unknown = null;
  for (let attempt = 1; attempt <= DROP_ATTEMPTS; attempt += 1) {
    try {
      await client.query(statement);
      return;
    } catch (err) {
      if (PgErrorCode.safeParse(err).data?.code !== OBJECT_IN_USE) {
        throw new ScratchDatabaseFailed("drop", name, describeErrorChain(err), { cause: err });
      }
      refusal = err;
    }
    if (attempt < DROP_ATTEMPTS) await delay(pauseMs);
  }
  throw new ScratchDatabaseFailed(
    "drop",
    name,
    `still in use after ${DROP_ATTEMPTS} forced drops ${pauseMs} ms apart: ${describeErrorChain(refusal)}`,
    { cause: refusal },
  );
}

/** The migrations' content hash: a template is reused only for exactly the migrations it ran. */
async function migrationsHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const file of (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort()) {
    hash
      .update(file)
      .update("\0")
      .update(await readFile(join(MIGRATIONS_DIR, file)))
      .update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/**
 * The template for this checkout's migrations, built once: migrated under a building name and
 * renamed when complete, so a failed build never leaves a template that looks finished.
 */
export async function prepareTemplate(baseUrl: string): Promise<string> {
  const name = `${TEMPLATE_PREFIX}${await migrationsHash()}`;
  return withAdmin(baseUrl, async (admin) => {
    await admin.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK]);
    try {
      // Another checkout's template may be in use by its own run: templates are never dropped here.
      const templates = await databaseNames(admin, TEMPLATE_PREFIX);
      if (templates.includes(name)) return name;
      const building = `${name}_building`;
      await dropDatabase(admin, building);
      await admin.query(`CREATE DATABASE ${quoted(building)}`);
      try {
        await runMigrations(urlFor(baseUrl, building), MIGRATIONS_DIR);
      } catch (err) {
        await dropDatabase(admin, building);
        throw new ScratchDatabaseFailed("migrate the template", building, describeErrorChain(err), { cause: err });
      }
      await admin.query(`ALTER DATABASE ${quoted(building)} RENAME TO ${quoted(name)}`);
      return name;
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK]);
    }
  });
}

/** Run databases left by a process that died more than an hour ago. */
export async function dropStaleRunDatabases(baseUrl: string): Promise<string[]> {
  const cutoff = Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS;
  return withAdmin(baseUrl, async (admin) => {
    const dropped: string[] = [];
    for (const name of await databaseNames(admin, RUN_PREFIX)) {
      const stamp = /^ashara_sim_r_(\d+)_/.exec(name)?.[1];
      // A name whose creation time does not parse is not known to be stale: kept, never dropped.
      if (stamp === undefined) {
        console.warn(
          `[simulator] run database ${name} names no creation time; left in place, drop it by hand if no run holds it`,
        );
        continue;
      }
      if (Number(stamp) < cutoff) {
        await dropDatabase(admin, name);
        dropped.push(name);
      }
    }
    return dropped;
  });
}

/** Run databases of a process known dead (a killed `--jobs` worker): its own cleanup never ran. */
export async function dropRunDatabasesOf(baseUrl: string, pid: number): Promise<string[]> {
  return withAdmin(baseUrl, async (admin) => {
    const dropped: string[] = [];
    for (const name of await databaseNames(admin, RUN_PREFIX)) {
      if (/^ashara_sim_r_\d+_(\d+)_\d+$/.exec(name)?.[1] !== String(pid)) continue;
      await dropDatabase(admin, name);
      dropped.push(name);
    }
    return dropped;
  });
}

let runCounter = 0;

export interface RunDatabase {
  readonly name: string;
  readonly url: string;
  drop(): Promise<void>;
}

const randomDefaultRows = z.array(z.object({ table: z.string(), column: z.string() }));

/**
 * Replaces every `gen_random_uuid()` column default of a run database with ids drawn from the seed
 * and the order of insertion. A database-drawn id is random per run, and production orders by such
 * ids (the startup reconciler walks projects by id), so two runs of one seed could walk two projects
 * in either order and a fault keyed by occurrence would land on a different item.
 */
async function seedDatabaseIds(baseUrl: string, name: string, seed: number): Promise<void> {
  const client = new pg.Client({ connectionString: urlFor(baseUrl, name), application_name: "ashara-sim-admin" });
  await client.connect();
  try {
    await client.query("CREATE SEQUENCE sim_uuid_seq");
    // Version 4 and variant 8 are written into the digest, so the id parses as a v4 uuid wherever production validates
    // one.
    await client.query(
      `CREATE FUNCTION sim_uuid() RETURNS uuid LANGUAGE sql AS $$
         SELECT (substr(h, 1, 12) || '4' || substr(h, 14, 3) || '8' || substr(h, 18))::uuid
         FROM md5('${String(seed >>> 0)}:' || nextval('sim_uuid_seq')) AS h
       $$`,
    );
    const columns = randomDefaultRows.parse(
      (
        await client.query(
          `SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns
           WHERE table_schema = 'public' AND column_default = 'gen_random_uuid()'`,
        )
      ).rows,
    );
    if (columns.length === 0)
      throw new ScratchDatabaseFailed(
        "seed ids",
        name,
        "no column defaults to gen_random_uuid(), so the schema changed under the simulator",
      );
    for (const { table, column } of columns) {
      await client.query(`ALTER TABLE ${quoted(table)} ALTER COLUMN ${quoted(column)} SET DEFAULT sim_uuid()`);
    }
  } finally {
    await client.end();
  }
}

export async function createRunDatabase(baseUrl: string, template: string, seed: number): Promise<RunDatabase> {
  runCounter += 1;
  const name = `${RUN_PREFIX}${Math.floor(Date.now() / 1000)}_${process.pid}_${runCounter}`;
  await withAdmin(baseUrl, async (admin) => {
    await admin.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK]);
    try {
      await admin.query(`CREATE DATABASE ${quoted(name)} TEMPLATE ${quoted(template)}`);
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK]);
    }
  });
  await seedDatabaseIds(baseUrl, name, seed);
  return {
    name,
    url: urlFor(baseUrl, name),
    drop: () => withAdmin(baseUrl, (admin) => dropDatabase(admin, name)),
  };
}

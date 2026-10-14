import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { z } from "zod";
import { MIGRATIONS_DIR, createDb, runMigrations } from "@ashara/db";
import { describeErrorChain } from "@ashara/shared";

/**
 * Scratch databases of design §4.14: one template migrated once per migration set, one database
 * per run created from it and dropped after, and stale run databases older than an hour dropped
 * at tier start. Never the shared database itself: every name starts with `ashara_sim_`.
 */
/** The observer's handle on a run database: read-only by use, never faulted. */
export type Database = ReturnType<typeof createDb>;

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

async function dropDatabase(client: pg.Client, name: string): Promise<void> {
  await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [name]);
  await client.query(`DROP DATABASE IF EXISTS ${quoted(name)}`);
}

/** The migrations' content hash: a template is reused only for exactly the migrations it ran. */
async function migrationsHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const file of (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort()) {
    hash.update(file).update("\0").update(await readFile(join(MIGRATIONS_DIR, file))).update("\0");
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
      const created = Number(/^ashara_sim_r_(\d+)_/.exec(name)?.[1] ?? "0");
      if (created < cutoff) {
        await dropDatabase(admin, name);
        dropped.push(name);
      }
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
    // Version 4 and variant 8 are written into the digest, so the id parses as a v4 uuid wherever production validates one.
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
    if (columns.length === 0) throw new ScratchDatabaseFailed("seed ids", name, "no column defaults to gen_random_uuid(), so the schema changed under the simulator");
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

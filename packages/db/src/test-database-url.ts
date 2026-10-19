import pg from "pg";
import { describeErrorChain } from "@ashara/shared";
import { DEFAULT_DATABASE_URL } from "./connection.js";

/**
 * Where tests and the simulator connect when TEST_DATABASE_URL is unset: the test Postgres of
 * docker/postgres-test.yml, whose data lives in tmpfs with fsync off, so scratch databases cost the
 * disk nothing. It is a different server from the shared one `DEFAULT_DATABASE_URL` names.
 */
const DEFAULT_TEST_DATABASE_URL = "postgresql://ashara@localhost:5433/ashara";

const TEST_DB_UP = "start it with `just test-db-up`";

type TestDatabaseRefusal =
  | { readonly kind: "invalid_url"; readonly url: string }
  | { readonly kind: "shared_database"; readonly url: string };

/** TEST_DATABASE_URL names no URL a test may use: not a URL, or the shared database itself. */
class TestDatabaseUrlRefused extends Error {
  readonly refusal: TestDatabaseRefusal;

  constructor(refusal: TestDatabaseRefusal, options?: ErrorOptions) {
    super(
      refusal.kind === "invalid_url"
        ? `TEST_DATABASE_URL is not a URL: ${refusal.url}`
        : `TEST_DATABASE_URL names the shared database (${refusal.url}); tests and the simulator run on the test Postgres, ${TEST_DB_UP} and leave TEST_DATABASE_URL unset or point it at a scratch database`,
      options,
    );
    this.name = "TestDatabaseUrlRefused";
    this.refusal = refusal;
  }
}

/** The test Postgres did not answer a connection: the run stops instead of falling back elsewhere. */
class TestDatabaseUnreachable extends Error {
  readonly url: string;

  constructor(url: string, options: ErrorOptions) {
    super(`the test Postgres at ${redacted(url)} is unreachable; ${TEST_DB_UP}`, options);
    this.name = "TestDatabaseUnreachable";
    this.url = url;
  }
}

function redacted(url: string): string {
  if (!URL.canParse(url)) return "an unparseable URL";
  const parsed = new URL(url);
  parsed.password = "";
  return parsed.toString();
}

function parsed(url: string): URL {
  try {
    return new URL(url);
  } catch (cause) {
    throw new TestDatabaseUrlRefused({ kind: "invalid_url", url }, { cause });
  }
}

/** Port and database name identify the shared database: every host spelling of the local server reaches it. */
function serverAndDatabase(url: URL): string {
  return `${url.port === "" ? "5432" : url.port}/${decodeURIComponent(url.pathname.replace(/^\//, ""))}`;
}

/**
 * The database URL every test and the simulator's test harness connect to: TEST_DATABASE_URL, else the
 * test Postgres. DATABASE_URL is never read, since it names the server's own database. A URL naming
 * the shared database is refused rather than used.
 */
export function resolveTestDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const url = env["TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;
  if (serverAndDatabase(parsed(url)) === serverAndDatabase(parsed(DEFAULT_DATABASE_URL))) {
    throw new TestDatabaseUrlRefused({ kind: "shared_database", url });
  }
  return url;
}

const PROBE_TIMEOUT_MS = 5_000;

/** Connects once to the server of `url` and fails closed, naming `just test-db-up`, when it does not answer. */
export async function assertTestDatabaseReachable(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: PROBE_TIMEOUT_MS });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (cause) {
    throw new TestDatabaseUnreachable(url, { cause });
  } finally {
    await client.end().catch((endError: unknown) => {
      console.warn(`[test-db] ending the probe connection failed: ${describeErrorChain(endError)}`);
    });
  }
}

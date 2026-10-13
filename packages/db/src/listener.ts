import pg from "pg";
import { z } from "zod";

export interface PgListener {
  /** Backend pid of the live LISTEN connection; null while not connected. */
  backendPid(): number | null;
  stop(): Promise<void>;
}

const BackendPidRowSchema = z.object({ pid: z.number().int() });

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function endQuietly(c: pg.Client, context: string): Promise<void> {
  return c.end().catch((err: unknown) => {
    console.warn(`[PG listener] ending the ${context} client failed:`, errorMessage(err));
  });
}

export async function listenForEvents(
  databaseUrl: string,
  callback: (eventType: string) => void,
): Promise<PgListener> {
  let stopped = false;
  let client: pg.Client | null = null;
  let pid: number | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  function drop(c: pg.Client, context: string): void {
    if (client !== c) return;
    client = null;
    pid = null;
    void endQuietly(c, context);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    const c = new pg.Client({ connectionString: databaseUrl });

    c.on("notification", (msg) => {
      if (msg.channel === "ashara_events" && msg.payload) {
        callback(msg.payload);
      }
    });

    // Handlers ignore a client that is no longer the live one, so a dropped client's
    // late events cannot schedule a second reconnect.
    c.on("error", (err: Error) => {
      if (client !== c) return;
      console.warn("[PG listener] connection error, reconnecting:", err.message);
      drop(c, "errored");
      scheduleReconnect();
    });

    c.on("end", () => {
      if (client !== c) return;
      client = null;
      pid = null;
      if (!stopped) scheduleReconnect();
    });

    let backendPid: number;
    try {
      await c.connect();
      await c.query("LISTEN ashara_events");
      const result = await c.query("SELECT pg_backend_pid() AS pid");
      backendPid = BackendPidRowSchema.parse(result.rows[0]).pid;
    } catch (e) {
      await endQuietly(c, "failed");
      throw e;
    }

    if (stopped) {
      await endQuietly(c, "late");
      return;
    }
    client = c;
    pid = backendPid;
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    attempt += 1;
    const delay = Math.min(1000 * 2 ** attempt, 30_000);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await connect();
        if (pid !== null) {
          console.log(`[PG listener] reconnected after ${attempt} attempt(s) (backend pid ${pid})`);
        }
        attempt = 0;
      } catch (e) {
        console.warn(
          `[PG listener] reconnect attempt ${attempt} failed, next in ${Math.min(1000 * 2 ** (attempt + 1), 30_000)}ms:`,
          errorMessage(e),
        );
        scheduleReconnect();
      }
    }, delay);
  }

  try {
    await connect();
  } catch (e) {
    console.warn("[PG listener] initial connection failed, will retry:", errorMessage(e));
    scheduleReconnect();
  }

  return {
    backendPid() {
      return pid;
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const c = client;
      client = null;
      pid = null;
      if (c) await endQuietly(c, "stopped");
    },
  };
}

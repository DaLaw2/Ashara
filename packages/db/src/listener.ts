import pg from "pg";
import { z } from "zod";
import type { Logger } from "@ashara/shared";

export interface PgListener {
  /** Backend pid of the live LISTEN connection; null while not connected. */
  backendPid(): number | null;
  stop(): Promise<void>;
}

const BackendPidRowSchema = z.object({ pid: z.number().int() });

/**
 * LISTENs on `ashara_events` and hands each payload to `callback`, reconnecting with backoff.
 * Every entry into the listener (a notification, a connection's error or end, a reconnect, the
 * first connect, the stop) runs in a new trace whose parent is the trace it was entered from,
 * so its records join a trace of their own rather than the logger's root.
 */
export async function listenForEvents(
  databaseUrl: string,
  callback: (eventType: string) => void,
  logger: Logger,
): Promise<PgListener> {
  let stopped = false;
  let client: pg.Client | null = null;
  let pid: number | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const traced = <T>(work: () => T): T => logger.scope({ trace: "new" }, work);

  function endQuietly(c: pg.Client, context: string): Promise<void> {
    return c.end().catch((err: unknown) => {
      logger.warn("db.listener-end-failed", `ending the ${context} LISTEN client failed`, { context }, err);
    });
  }

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
      traced(() => {
        if (msg.channel === "ashara_events" && msg.payload) {
          callback(msg.payload);
        }
      });
    });

    // Handlers ignore a client that is no longer the live one, so a dropped client's
    // late events cannot schedule a second reconnect.
    c.on("error", (err: Error) => {
      traced(() => {
        if (client !== c) return;
        logger.warn("db.listener-error", "LISTEN connection error, reconnecting", {}, err);
        drop(c, "errored");
        scheduleReconnect();
      });
    });

    c.on("end", () => {
      traced(() => {
        if (client !== c) return;
        client = null;
        pid = null;
        if (!stopped) scheduleReconnect();
      });
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
    reconnectTimer = setTimeout(() => {
      void traced(async () => {
        reconnectTimer = null;
        try {
          await connect();
          if (pid !== null) {
            logger.info("db.listener-reconnected", `LISTEN reconnected after ${attempt} attempt(s) (backend pid ${pid})`, { attempts: attempt, pid });
          }
          attempt = 0;
        } catch (e) {
          // eslint-disable-next-line ashara/catch-continue -- best effort: the next reconnect is scheduled with backoff, and a NOTIFY only wakes the runner early: its poll interval picks the same work up without one
          logger.warn(
            "db.listener-reconnect-failed",
            `LISTEN reconnect attempt ${attempt} failed, next in ${Math.min(1000 * 2 ** (attempt + 1), 30_000)}ms`,
            { attempts: attempt },
            e,
          );
          scheduleReconnect();
        }
      });
    }, delay);
  }

  await traced(async () => {
    try {
      await connect();
    } catch (e) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the reconnect is scheduled with backoff, and a NOTIFY only wakes the runner early: its poll interval picks the same work up without one
      logger.warn("db.listener-connect-failed", "LISTEN initial connection failed, will retry", {}, e);
      scheduleReconnect();
    }
  });

  return {
    backendPid() {
      return pid;
    },
    stop() {
      return traced(async () => {
        stopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        const c = client;
        client = null;
        pid = null;
        if (c) await endQuietly(c, "stopped");
      });
    },
  };
}

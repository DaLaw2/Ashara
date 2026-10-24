import pg from "pg";
import { z } from "zod";
import type { Logger } from "@ashara/shared";

/** Its functions hold no `this`: a caller may destructure them. */
export interface PgListener {
  /** Backend pid of the live LISTEN connection; null while not connected. */
  readonly backendPid: () => number | null;
  readonly stop: () => Promise<void>;
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
  const listener = new EventsListener(databaseUrl, callback, logger);
  await listener.start();
  return { backendPid: () => listener.backendPid(), stop: () => listener.stop() };
}

/** The live LISTEN connection, the reconnect pending while there is none, and whether it was stopped. */
class EventsListener {
  private stopped = false;
  private client: pg.Client | null = null;
  private pid: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;

  constructor(
    private readonly databaseUrl: string,
    private readonly callback: (eventType: string) => void,
    private readonly logger: Logger,
  ) {}

  backendPid(): number | null {
    return this.pid;
  }

  stop(): Promise<void> {
    return this.traced(async () => {
      this.stopped = true;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      const c = this.client;
      this.client = null;
      this.pid = null;
      if (c) await this.endQuietly(c, "stopped");
    });
  }

  /** The first connect; one that fails schedules the reconnects. */
  async start(): Promise<void> {
    await this.traced(async () => {
      try {
        await this.connect();
      } catch (e) {
        // eslint-disable-next-line ashara/catch-continue -- best effort: the reconnect is scheduled with backoff, and a NOTIFY only wakes the runner early: its poll interval picks the same work up without one
        this.logger.warn("db.listener-connect-failed", "LISTEN initial connection failed, will retry", {}, e);
        this.scheduleReconnect();
      }
    });
  }

  private traced<T>(work: () => T): T {
    return this.logger.scope({ trace: "new" }, work);
  }

  private endQuietly(c: pg.Client, context: string): Promise<void> {
    return c.end().catch((err: unknown) => {
      this.logger.warn("db.listener-end-failed", `ending the ${context} LISTEN client failed`, { context }, err);
    });
  }

  private drop(c: pg.Client, context: string): void {
    if (this.client !== c) return;
    this.client = null;
    this.pid = null;
    void this.endQuietly(c, context);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const c = new pg.Client({ connectionString: this.databaseUrl });

    c.on("notification", (msg) => {
      this.traced(() => {
        if (msg.channel === "ashara_events" && msg.payload) {
          this.callback(msg.payload);
        }
      });
    });

    // Handlers ignore a client that is no longer the live one, so a dropped client's
    // late events cannot schedule a second reconnect.
    c.on("error", (err: Error) => {
      this.traced(() => {
        if (this.client !== c) return;
        this.logger.warn("db.listener-error", "LISTEN connection error, reconnecting", {}, err);
        this.drop(c, "errored");
        this.scheduleReconnect();
      });
    });

    c.on("end", () => {
      this.traced(() => {
        if (this.client !== c) return;
        this.client = null;
        this.pid = null;
        if (!this.stopped) this.scheduleReconnect();
      });
    });

    let backendPid: number;
    try {
      await c.connect();
      await c.query("LISTEN ashara_events");
      const result = await c.query("SELECT pg_backend_pid() AS pid");
      backendPid = BackendPidRowSchema.parse(result.rows[0]).pid;
    } catch (e) {
      await this.endQuietly(c, "failed");
      throw e;
    }

    if (this.stopped) {
      await this.endQuietly(c, "late");
      return;
    }
    this.client = c;
    this.pid = backendPid;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempt += 1;
    const delay = Math.min(1000 * 2 ** this.attempt, 30_000);
    this.reconnectTimer = setTimeout(() => {
      void this.traced(async () => {
        this.reconnectTimer = null;
        try {
          await this.connect();
          if (this.pid !== null) {
            this.logger.info("db.listener-reconnected", `LISTEN reconnected after ${this.attempt} attempt(s) (backend pid ${this.pid})`, { attempts: this.attempt, pid: this.pid });
          }
          this.attempt = 0;
        } catch (e) {
          // eslint-disable-next-line ashara/catch-continue -- best effort: the next reconnect is scheduled with backoff, and a NOTIFY only wakes the runner early: its poll interval picks the same work up without one
          this.logger.warn(
            "db.listener-reconnect-failed",
            `LISTEN reconnect attempt ${this.attempt} failed, next in ${Math.min(1000 * 2 ** (this.attempt + 1), 30_000)}ms`,
            { attempts: this.attempt },
            e,
          );
          this.scheduleReconnect();
        }
      });
    }, delay);
  }
}

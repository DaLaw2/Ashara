import pg from "pg";

export interface PgListener {
  stop(): void;
}

export async function listenForEvents(
  databaseUrl: string,
  callback: (eventType: string) => void,
): Promise<PgListener> {
  let stopped = false;
  let client: pg.Client | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  async function connect(): Promise<void> {
    if (stopped) return;
    client = new pg.Client({ connectionString: databaseUrl });

    client.on("notification", (msg) => {
      if (msg.channel === "ashara_events" && msg.payload) {
        callback(msg.payload);
      }
    });

    client.on("error", (err: Error) => {
      console.warn("[PG listener] connection error, reconnecting:", err.message);
      scheduleReconnect();
    });

    client.on("end", () => {
      if (!stopped) scheduleReconnect();
    });

    await client.connect();
    await client.query("LISTEN ashara_events");
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    attempt += 1;
    const delay = Math.min(1000 * 2 ** attempt, 30_000);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await connect();
        attempt = 0;
      } catch (e) {
        console.warn(
          `[PG listener] reconnect attempt ${attempt} failed:`,
          (e as Error).message,
        );
        scheduleReconnect();
      }
    }, delay);
  }

  try {
    await connect();
  } catch (e) {
    console.warn(
      "[PG listener] initial connection failed, will retry:",
      (e as Error).message,
    );
    scheduleReconnect();
  }

  return {
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      client?.end().catch(() => {});
    },
  };
}

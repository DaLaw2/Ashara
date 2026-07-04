import pg from "pg";

export async function listenForEvents(
  databaseUrl: string,
  callback: (eventType: string) => void,
): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("LISTEN ashara_events");

  client.on("notification", (msg) => {
    if (msg.channel === "ashara_events" && msg.payload) {
      callback(msg.payload);
    }
  });

  client.on("error", (err: Error) => {
    console.error("PG listener connection error:", err.message);
  });

  return client;
}

import { describe, expect, test } from "vitest";
import { dropDatabase } from "./database.js";

class PgRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PgRefusal";
  }
}

/** A stand-in admin client that refuses the first `refusals` drops with `code`, then drops. */
function refusingClient(refusals: number, code: string): { statements: string[]; query(text: string): Promise<unknown> } {
  const statements: string[] = [];
  return {
    statements,
    query(text: string): Promise<unknown> {
      statements.push(text);
      if (statements.length <= refusals) {
        return Promise.reject(new PgRefusal(code, `database "x" is being accessed by other users (${statements.length})`));
      }
      return Promise.resolve({ rows: [] });
    },
  };
}

describe("dropping a scratch database", () => {
  test("ends the database's sessions in the drop itself", async () => {
    const client = refusingClient(0, "55006");
    await dropDatabase(client, "ashara_sim_r_1_2_3", 0);
    expect(client.statements).toEqual(['DROP DATABASE IF EXISTS "ashara_sim_r_1_2_3" WITH (FORCE)']);
  });

  test("a drop refused as in use is retried until a backend has exited", async () => {
    const client = refusingClient(3, "55006");
    await dropDatabase(client, "ashara_sim_r_1_2_3", 0);
    expect(client.statements).toHaveLength(4);
  });

  test("a database still in use after the bounded retries fails, carrying the last refusal as its cause", async () => {
    const client = refusingClient(Number.POSITIVE_INFINITY, "55006");
    const failure = await dropDatabase(client, "ashara_sim_r_1_2_3", 0).then(
      () => expect.unreachable("the drop succeeded although every attempt was refused"),
      (err: unknown) => err,
    );
    expect(client.statements).toHaveLength(5);
    expect(failure).toMatchObject({ name: "ScratchDatabaseFailed", operation: "drop", database: "ashara_sim_r_1_2_3" });
    expect(String((failure as Error).message)).toContain("still in use after 5 forced drops");
    expect((failure as Error).cause).toMatchObject({ code: "55006", message: expect.stringContaining("(5)") });
  });

  test("any other refusal fails at once with its cause", async () => {
    const client = refusingClient(1, "42501");
    const failure = await dropDatabase(client, "ashara_sim_r_1_2_3", 0).then(
      () => expect.unreachable("the drop succeeded although it was refused"),
      (err: unknown) => err,
    );
    expect(client.statements).toHaveLength(1);
    expect(failure).toMatchObject({ name: "ScratchDatabaseFailed", cause: { code: "42501" } });
  });
});

import { asc, eq } from "drizzle-orm";
import type { DbHandle } from "../connection.js";
import { clients } from "../schema.js";

interface ClientRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

/** The firm's clients (migration 018): who a project belongs to and a session acts for. */
export class ClientRepository {
  constructor(private readonly db: DbHandle) {}

  async create(name: string): Promise<ClientRecord> {
    const [row] = await this.db.insert(clients).values({ name }).returning();
    return row;
  }

  async get(id: string): Promise<ClientRecord | null> {
    const [row] = await this.db.select().from(clients).where(eq(clients.id, id)).limit(1);
    return row ?? null;
  }

  async findByName(name: string): Promise<ClientRecord | null> {
    const [row] = await this.db.select().from(clients).where(eq(clients.name, name)).limit(1);
    return row ?? null;
  }

  async list(): Promise<ClientRecord[]> {
    return this.db.select().from(clients).orderBy(asc(clients.name));
  }
}

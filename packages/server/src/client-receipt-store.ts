import { listDueReceipts, postClientReceipt } from "@ashara/engagement";
import type { createDb } from "@ashara/db";
import type { ClientReceiptStore } from "@ashara/engagement";

/** Engagement's receipt store over client_messages, projects and project_blocks. */
export function createClientReceiptStore(db: ReturnType<typeof createDb>): ClientReceiptStore {
  return {
    dueReceipts: () => listDueReceipts(db),
    postReceipt: (write) => postClientReceipt(db, write),
  };
}

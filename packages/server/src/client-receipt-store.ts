import { listDueReceipts, postClientReceipt } from "@ashara/engagement";
import type { Database } from "@ashara/db";
import type { ClientReceiptStore } from "@ashara/engagement";

/** Engagement's receipt store over client_messages, projects and project_blocks. */
export function createClientReceiptStore(db: Database): ClientReceiptStore {
  return {
    dueReceipts: () => listDueReceipts(db),
    postReceipt: (write) => postClientReceipt(db, write),
  };
}

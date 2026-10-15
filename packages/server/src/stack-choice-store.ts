import { listDueStackChoices, recordStackChoice } from "@ashara/engagement";
import type { createDb } from "@ashara/db";
import { ProjectHaltRepository } from "@ashara/delivery";
import type { StackChoiceStore } from "@ashara/engagement";

/** Engagement's stack-choice store over work_items, vision_documents and client_messages. */
export function createStackChoiceStore(db: ReturnType<typeof createDb>): StackChoiceStore {
  const projects = new ProjectHaltRepository(db);
  return {
    dueStackChoices: () => listDueStackChoices(db),
    recordStackChoice: (write) => recordStackChoice(db, write),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
  };
}

import { listOpenAnswers, readOpenAnswer, recordAnswerFailure, recordClientAnswer } from "@ashara/engagement";
import { ProjectRepository } from "@ashara/db";
import type { createDb } from "@ashara/db";
import type { AnswerStore } from "@ashara/engagement";

/** Engagement's answer store over client_messages, vision_documents and projects. */
export function createAnswerStore(db: ReturnType<typeof createDb>): AnswerStore {
  const projects = new ProjectRepository(db);
  return {
    openAnswers: () => listOpenAnswers(db),
    openAnswer: (answerId) => readOpenAnswer(db, answerId),
    recordAnswer: (write) => recordClientAnswer(db, write),
    recordFailedAttempt: (answerId, error) => recordAnswerFailure(db, answerId, error),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
  };
}

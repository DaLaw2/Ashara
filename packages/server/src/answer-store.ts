import { listOpenAnswers, readOpenAnswer, recordAnswerFailure, recordClientAnswer } from "@ashara/engagement";
import type { Database } from "@ashara/db";
import { ProjectHaltRepository, holdCorrection } from "@ashara/delivery";
import type { AnswerStore } from "@ashara/engagement";

/** Engagement's answer store over client_messages, vision_documents and projects, with Delivery's hold on the work a correcting answer touches. */
export function createAnswerStore(db: Database): AnswerStore {
  const projects = new ProjectHaltRepository(db);
  return {
    openAnswers: () => listOpenAnswers(db),
    openAnswer: (answerId) => readOpenAnswer(db, answerId),
    recordAnswer: (write) => recordClientAnswer(db, write, holdCorrection),
    recordFailedAttempt: (answerId, error, failure) => recordAnswerFailure(db, answerId, error, failure),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
  };
}

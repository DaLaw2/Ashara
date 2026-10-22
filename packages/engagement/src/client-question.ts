import { and, eq } from "drizzle-orm";
import { projects } from "@ashara/db";
import type { Database } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import { noOpenStop, projectAtWork } from "./predicates.js";
import { ClientMessageRepository, questionAnswerRead } from "./repositories/client-message.js";
import { VisionRepository } from "./repositories/vision.js";
import type { RevisionRecord } from "./vision-language/contract-op.js";
import { ASSUMPTION_LABEL } from "./vision-language/vision-assumption.js";
import { Vision, VisionChangeRefused, VisionUnreadable } from "./vision.js";

// A decision only the client can make, which a task of the plan cannot go on without, put to the
// client on the channel intake's questions use: the question is posted, and the vision records what
// stands until it is answered as an Inferred assumption the question asks about, so the client's
// answer is read as every other answer is (answers.ts). The task waits on the answer; the rest of the
// plan goes on. Delivery holds the task first under the question's id and asks after, as often as it
// takes: the question is posted once, under that id, and asking again finds it on record.

/** A task's question for the client, as Delivery asks it. */
export interface TaskQuestion {
  /** The id the question is posted under, chosen by Delivery with the task's hold. */
  readonly questionId: string;
  readonly projectId: ProjectId;
  readonly taskId: string;
  readonly taskTitle: string;
  /** The question as the task's implementer wrote it for the client. */
  readonly question: string;
  /** What the tender and the vision say now, which stands until the client answers. */
  readonly assumption: string;
  /** The guarantees the task delivers: the decision underpins them. */
  readonly underpins: readonly string[];
}

/** What asking did: the question posted now, found posted already, or why it could not be posted. */
export type TaskQuestionPosting =
  | { readonly kind: "posted"; readonly questionId: string; readonly assumptionKey: string; readonly visionVersion: number }
  | { readonly kind: "on-record"; readonly questionId: string }
  | { readonly kind: "not-askable"; readonly why: string };

/** The id a task's question is to be posted under is already another message's: not this question's post. */
class TaskQuestionIdTaken extends Error {
  constructor(
    readonly questionId: string,
    readonly projectId: ProjectId,
    readonly found: { readonly projectId: string; readonly direction: string; readonly kind: string },
  ) {
    super(
      `task question ${questionId} for project ${projectId}: the id is already a ${found.direction} ${found.kind} of project ${found.projectId}, ` +
        "not this question's post",
    );
    this.name = "TaskQuestionIdTaken";
  }
}

/** The vision moved under the project's lock: a writer appended without taking it. */
class TaskQuestionVisionMoved extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly basedOn: number,
    readonly current: number | null,
  ) {
    super(
      `task question for project ${projectId} was composed against vision v${basedOn} under the project's lock, ` +
        `but the current version is ${current === null ? "none" : `v${current}`}`,
    );
    this.name = "TaskQuestionVisionMoved";
  }
}

/** Plain words: what is asked, why the work needs it, and what stands until it is answered. */
function questionBody(question: TaskQuestion): string {
  return [
    question.question,
    `Why it matters: the team cannot finish "${question.taskTitle}" without your decision; that work waits for your answer, and the rest goes on.`,
    `${ASSUMPTION_LABEL} ${question.assumption}`,
  ].join("\n\n");
}

/**
 * Posts the question under `question.questionId` and appends the next vision version, in which what
 * stands until it is answered is an Inferred assumption the question is open on, in one transaction
 * under the project's row lock. A question already posted under that id is on record, and nothing
 * is written. Not askable while the project is not at work (stopped, delivered or halted, or with a
 * stop awaiting the Liaison), or when its vision cannot carry the assumption.
 */
export async function askTaskQuestion(db: Database, question: TaskQuestion): Promise<TaskQuestionPosting> {
  return db.transaction(async (tx): Promise<TaskQuestionPosting> => {
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, question.projectId)).for("update");
    const messages = new ClientMessageRepository(tx);
    const found = await messages.findById(question.questionId);
    if (found !== null) {
      if (found.projectId !== question.projectId || found.direction !== "outbound" || found.kind !== "question") {
        throw new TaskQuestionIdTaken(question.questionId, question.projectId, found);
      }
      return { kind: "on-record", questionId: found.id };
    }
    const [atWork] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, question.projectId), projectAtWork(), noOpenStop(projects.id)));
    if (atWork === undefined) return { kind: "not-askable", why: `project ${question.projectId} is not at work` };
    const visions = new VisionRepository(tx);
    const stored = await visions.getCurrent(question.projectId);
    if (stored === null) return { kind: "not-askable", why: `project ${question.projectId} has no vision` };
    let vision: Vision;
    try {
      vision = Vision.read(stored);
    } catch (err) {
      if (!(err instanceof VisionUnreadable)) throw err;
      return { kind: "not-askable", why: `vision v${stored.version} is not readable: ${err.message}` };
    }
    const underpins = question.underpins.filter((key) => vision.current.guarantees.some((guarantee) => guarantee.id === key));
    const posted = await messages.insertOutbound({
      id: question.questionId,
      projectId: question.projectId,
      kind: "question",
      body: questionBody(question),
      inReplyTo: null,
    });
    let asked: ReturnType<Vision["appendAsked"]>;
    try {
      asked = vision.appendAsked(
        {
          statement: question.assumption,
          rationale: `What the tender and the vision say now; task ${question.taskId} cannot go on without the client's decision on it.`,
          // A decision only the client can make is one the client observes, through the guarantees the task delivers.
          kind: underpins.length > 0 ? "client-visible" : "internal-design",
          disclosed: "asked",
          underpins,
          changeReason: (key) => `task ${question.taskId} asked the client a question (message ${posted.id}); recorded as Inferred assumption ${key}`,
        },
        { messageId: posted.id, text: question.question },
      );
    } catch (err) {
      if (!(err instanceof VisionChangeRefused)) throw err;
      // Nothing is written: the question posted above rolls back with the transaction.
      throw new TaskQuestionUnrecordable(question.projectId, question.taskId, err);
    }
    const revision: RevisionRecord = {
      author: "ashara",
      sourceMessageId: null,
      approver: null,
      // What stands until the client answers promises the client nothing new.
      direction: "neutral",
      cause: "ashara-decision",
      ops: [{ target: "assumption", action: "add", key: asked.key, direction: "neutral", labelled: null, read: null, statement: question.assumption }],
      pushback: null,
    };
    const appended = await visions.append(question.projectId, asked, revision);
    if (appended.kind === "moved") throw new TaskQuestionVisionMoved(question.projectId, asked.basedOnVersion, appended.current);
    return { kind: "posted", questionId: posted.id, assumptionKey: asked.key, visionVersion: appended.version };
  }).catch((err: unknown) => {
    if (err instanceof TaskQuestionUnrecordable) return { kind: "not-askable" as const, why: err.message };
    throw err;
  });
}

/** The project's vision refused the assumption the question rests on: nothing is posted. */
class TaskQuestionUnrecordable extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly taskId: string,
    cause: VisionChangeRefused,
  ) {
    super(`project ${projectId}: task ${taskId}'s question cannot be recorded in the vision: ${cause.message}`, { cause });
    this.name = "TaskQuestionUnrecordable";
  }
}

/** Whether the client's answer to the question has been read: an answer to it was consumed. */
export function taskQuestionAnswered(db: Database, questionId: string): Promise<boolean> {
  return questionAnswerRead(db, questionId);
}

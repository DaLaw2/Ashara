import type { Logger, ProjectId, StepContainment } from "@ashara/shared";
import { containEach } from "@ashara/shared";
import type { WorkItemRepository } from "./domain/index.js";
import type { ClientQuestions } from "./execution/dispatch-run-deps.js";

// The automatic exit of a project halted on client_wait (parked-exits.ts halts it once no work of it
// could proceed but on the client's answers): the client answers, the Liaison reads the answer as it
// reads every answer, halted or not, and the loop resumes the project by itself. Each cycle, every
// such halt already told to the client is checked against the questions its held tasks wait on (no
// LLM call); the first answer read ends the halt with what was answered, the project returns to
// work, the parked exits send the answered task back to Pending, and the Liaison tells the client
// once. An answer not yet read leaves the halt as it is.

/** The project store's view of client_wait halts. ProjectHaltRepository satisfies it. */
export interface ClientWaitHalts {
  /** Projects halted on client_wait whose halt report is posted, oldest first. */
  listClientWaitHalted(): Promise<ProjectId[]>;
  /**
   * Ends the project's client_wait halt with what the client answered and returns it to work;
   * "moved" when it is not so halted any more, "unreported" when its halt report is not yet posted.
   */
  resumeFromClientWait(projectId: ProjectId, evidence: string): Promise<"resumed" | "moved" | "unreported">;
}

interface ClientWaitResumeDeps {
  readonly halts: ClientWaitHalts;
  readonly workItemRepo: Pick<WorkItemRepository, "findByProjectAndStatus">;
  readonly clientQuestions: Pick<ClientQuestions, "answered">;
  readonly containment: StepContainment;
  readonly logger: Logger;
}

/** Returns how many projects resumed this cycle; a project whose resumption fails is contained to it (containEach). */
export async function resumeClientWaitHalts(deps: ClientWaitResumeDeps): Promise<number> {
  const halted = await deps.halts.listClientWaitHalted();
  const outcomes = await containEach(deps.containment, "client-wait-resume", halted, (projectId) => ({ id: projectId, projectId }), (projectId) => resumeOnAnswer(deps, projectId));
  return outcomes.filter((outcome) => outcome === "resumed").length;
}

async function resumeOnAnswer(deps: ClientWaitResumeDeps, projectId: ProjectId): Promise<"resumed" | "moved" | "unreported" | "unanswered"> {
  const held = (await deps.workItemRepo.findByProjectAndStatus(projectId, "Blocked")).flatMap((item) =>
    item.blockedReason?.source === "awaiting_client" ? [{ taskId: item.id, questionId: item.blockedReason.questionId }] : [],
  );
  if (held.length === 0) {
    deps.logger.warn("delivery.client-wait-unheld", `project ${projectId} is halted on client_wait, but no task of it waits on a question: only the operator's unblock ends it`, {
      projectId,
    });
    return "unanswered";
  }
  let answered: { readonly taskId: string; readonly questionId: string } | null = null;
  for (const each of held) {
    if (await deps.clientQuestions.answered(each.questionId)) {
      answered = each;
      break;
    }
  }
  if (answered === null) {
    deps.logger.info("delivery.client-wait-continues", `project ${projectId} stays halted: no answer to its held questions is read yet`, {
      projectId,
      questionIds: held.map((each) => each.questionId),
    });
    return "unanswered";
  }
  const evidence = `the client's answer to question ${answered.questionId}, which task ${answered.taskId} waits on, is read`;
  const outcome = await deps.halts.resumeFromClientWait(projectId, evidence);
  if (outcome === "resumed") {
    deps.logger.info("delivery.client-wait-resumed", `project ${projectId} resumed: ${evidence}`, { projectId, questionId: answered.questionId, outcome });
  } else if (outcome === "unreported") {
    deps.logger.info("delivery.client-wait-resume-deferred", `project ${projectId} not resumed yet: its halt report is not posted, so it stays halted until the client is told`, {
      projectId,
      outcome,
    });
  } else {
    deps.logger.info("delivery.client-wait-resume-deferred", `project ${projectId} not resumed: it is no longer halted on client_wait`, { projectId, outcome });
  }
  return outcome;
}

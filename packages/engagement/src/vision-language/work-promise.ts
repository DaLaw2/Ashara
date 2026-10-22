import type { ContractStanding } from "./guarantee.js";

// What a client message may say of the work on a project, by the standing of the contract in force.
// Every sentence that says work goes on, resumes, is planned or is revised is here and nowhere else,
// keyed by the standing, so a message composed for a held contract cannot say work will resume: it has
// only the held words to compose from. A held contract's messages end with the decline itself
// (NOTHING_VERIFIABLE), which says what starts work; an unread standing promises nothing either way.

/** The sentences a client message composes what happens to the work from. */
interface WorkWords {
  /** How a report opens on a paused project. */
  readonly paused: string;
  /** How a receipt states a paused project, before its end. */
  readonly pausedFor: string;
  /** How a receipt states a project that is not paused. */
  readonly atWork: string;
  /** When what waits for a pause's end is read: once work resumes, or once the pause ends. */
  readonly afterPause: string;
  /** When the client hears next of a pause. */
  readonly toldNext: string;
  /** What the operator does to end a pause, after "the team's operator". */
  readonly operatorEnds: string;
  /** What lasts until the operator has done `what` and ended a pause. */
  readonly untilOperator: (what: string) => string;
  /** What a halt report says of the work while the pause lasts; null when no work is promised after it. */
  readonly noMoreWork: string | null;
  /** What Ashara does by itself once the machines it runs the work on answer, after "Ashara"; `answer` says when. */
  readonly machinesEnd: (answer: string) => string;
  /** The step a pause's end leads to, after what has to happen first; empty when no work is promised. */
  readonly before: (step: string) => string;
  /** What a change sent during a pause does to the plan; null when no plan is promised. */
  readonly planOnResumption: string | null;
  /** What a message read during a pause leads to once the pause ends; null when no work is promised. */
  readonly workAfterPause: string | null;
  /** What a project's resumption report says, after what ended the pause. */
  readonly resumed: (cause: string) => string;
  /** What a receipt for a stop taken before the project was reopened says of it now. */
  readonly reopened: string;
  /** What reading an answer leads to, after "Ashara reads it". */
  readonly answerRead: string;
  /** What reading a change leads to, after "Ashara reads it". */
  readonly changeRead: string;
  /** What a correction note read during a pause closes with. */
  readonly correctionPaused: string;
  /** What a correction note applied while the project is not paused says of the work planned; empty when none runs. */
  readonly plannedContinues: string;
  /** How a correction note held for the client's confirmation closes. */
  readonly confirmClose: string;
  /** What an answer that changes what a plan rests on is recorded as. */
  readonly answerRestsOn: string;
  /** What an answer that changes what a plan rests on does to the plan; `paused` when the project is paused. */
  readonly answerReplans: (paused: boolean) => string;
}

const PAUSED_FOR = "This project is paused, for the reason Ashara's report of the pause gives";

/** The words of a standing on which no work is promised. */
const NO_WORK_PROMISED: Omit<WorkWords, "atWork" | "reopened" | "resumed" | "answerReplans"> = {
  paused: "This project is paused.",
  pausedFor: PAUSED_FOR,
  afterPause: "once the pause ends",
  toldNext: "you will be told when the pause ends",
  operatorEnds: "ends the pause",
  untilOperator: (what) => `The pause lasts until the team's operator ${what} and ends it`,
  noMoreWork: null,
  machinesEnd: (answer) => `ends this pause by itself as soon as ${answer}`,
  before: () => "",
  planOnResumption: null,
  workAfterPause: null,
  answerRead: "and records what it changes in what the contract rests on",
  changeRead: "and replies with what it changes in the contract and how many of its guarantees Ashara can then verify",
  correctionPaused: `${PAUSED_FOR}, and this message does not end the pause. The contract stands as this note says now.`,
  plannedContinues: "",
  confirmClose: "This change will be made as you sent it once you confirm.",
  answerRestsOn: "The contract now rests on:",
};

/** An answer's report on a project no work is promised on: whether paused, then `plan`. */
function answerNoReplan(paused: boolean, plan: string): string {
  return `${paused ? `${PAUSED_FOR}, and this answer does not end the pause. ` : ""}${plan}`;
}

export const WORK_WORDS: Readonly<Record<ContractStanding, WorkWords>> = {
  workable: {
    paused: "Work on this project is paused.",
    pausedFor: "Work on this project is paused, for the reason Ashara's report of the pause gives",
    atWork: "This project is at work.",
    afterPause: "once work resumes",
    toldNext: "you will be told when work resumes",
    operatorEnds: "resumes the project",
    untilOperator: (what) => `Nothing more is built until the team's operator ${what} and resumes the project`,
    noMoreWork: "Until then no more work is done on this project",
    machinesEnd: (answer) => `resumes this project by itself as soon as ${answer}`,
    before: (step) => ` before ${step}`,
    planOnResumption: "The plan is revised for it once work resumes.",
    workAfterPause: "the work it touches is planned for it once work resumes",
    resumed: (cause) => `Work on this project has resumed: ${cause}, and the work goes on from where it stopped.`,
    reopened: "the project has since been returned to work.",
    answerRead: "and, if it changes what the plan rests on, the work that rests on it is planned again and you are told what changes",
    changeRead: "and replies with what it changes, the work it touches and what that costs",
    correctionPaused:
      "Work on this project is paused, for the reason Ashara's report of the pause gives, and this message does not end the pause. " +
      "The contract stands as this note says now, and the work it touches is planned for it once work resumes.",
    plannedContinues: " Work already planned continues meanwhile.",
    confirmClose: "This change will be made as you sent it once you confirm; nothing else waits.",
    answerRestsOn: "Work now proceeds on:",
    answerReplans: (paused) =>
      paused
        ? `The plan has to be revised for this change. Work on this project is paused, for the reason Ashara's report of the ` +
          `pause gives, and this answer does not end the pause: once work resumes, the team revises the part of the plan that ` +
          `rests on it before that part goes on, and you will be told what changes.`
        : `The plan has to be revised for this change. Only the work that rests on it waits: work on it already ` +
          `running finishes first, then the team revises that part of the plan, and you will be told what changes. ` +
          `The rest of the work goes on meanwhile.`,
  },
  held: {
    ...NO_WORK_PROMISED,
    atWork: "No work runs on this project: Ashara holds its contract, for the reason this message ends with.",
    resumed: (cause) => `The pause on this project has ended: ${cause}. No work runs on it while Ashara holds its contract, for the reason this report ends with.`,
    reopened: "the project has since been reopened, and its contract is still held.",
    answerReplans: (paused) => answerNoReplan(paused, "No work rests on it: no work runs on this project while Ashara holds its contract."),
  },
  unread: {
    ...NO_WORK_PROMISED,
    atWork: "Whether work runs on this project cannot be told from Ashara's records for this message.",
    resumed: (cause) => `The pause on this project has ended: ${cause}. Whether work runs on it now cannot be told from Ashara's records for this report.`,
    reopened: "the project has since been reopened.",
    answerReplans: (paused) => answerNoReplan(paused, "Whether the plan changes for it cannot be told from Ashara's records for this message."),
  },
};

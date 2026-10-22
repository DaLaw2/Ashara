import { describe, expect, test } from "vitest";
import { WORK_WORDS } from "./work-promise.js";

// Every sentence a client message says of the work comes from WORK_WORDS by the contract's standing: the
// halt and resumption reports, the receipts, the correction notes and the answer reports compose from
// nothing else. On a held contract, or one whose standing does not read, none of them promises that
// work resumes, goes on, is planned or is revised.

const PROMISES = [
  /work resumes/i,
  /has resumed/i,
  /goes on/i,
  /resumes (the|this) project/i,
  /continues/i,
  /is planned/i,
  /planned again/i,
  /revised for it/i,
  /revises/i,
  /work proceeds/i,
  /proceeds on/i,
  /returned to work/i,
  /is at work/i,
  /nothing else waits/i,
  /no more work is done/i,
  /nothing more is built/i,
  /work on this project is paused/i,
  /before /i,
];

/** Every sentence a standing's words can compose, by the field it comes from, each function called as its composers call it. */
function sentences(standing: keyof typeof WORK_WORDS): Array<readonly [string, string]> {
  const words = WORK_WORDS[standing];
  return Object.entries(words).flatMap(([field, value]): Array<readonly [string, string]> => {
    if (typeof value === "string") return [[field, value]];
    if (value === null) return [];
    if (field === "answerReplans") return [true, false].map((paused) => [field, words.answerReplans(paused)] as const);
    if (field === "before") return [[field, words.before("planning is tried again")]];
    if (field === "machinesEnd") return [[field, words.machinesEnd("they answer")]];
    if (field === "untilOperator") return [[field, words.untilOperator("resolves this")]];
    if (field === "resumed") return [[field, words.resumed("the team cleared what paused it")]];
    throw new Error(`no call is written for the words' field ${field}`);
  });
}

describe("the words a client message says of the work", () => {
  test.each(["held", "unread"] as const)("on a %s contract, promise no work", (standing) => {
    for (const [field, sentence] of sentences(standing)) for (const promise of PROMISES) expect(sentence, field).not.toMatch(promise);
  });

  test("on a workable contract, say what work follows", () => {
    const all = sentences("workable").map(([, sentence]) => sentence).join("\n");
    for (const promise of [/work resumes/, /goes on/, /resumes the project/, /is planned/, /revises/, /proceeds on/, /is at work/]) expect(all).toMatch(promise);
  });
});

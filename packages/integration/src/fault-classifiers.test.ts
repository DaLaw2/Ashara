import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { exhaustedRevisionCause } from "@ashara/delivery";
import { modelCallBlockCategory, projectBlockCause, recordedFailureOf } from "@ashara/delivery/project-halt";
import { modelCallFailureOf } from "@ashara/finance";
import { providerFailureOf } from "@ashara/model-access";
import { environmentErrorOf, thrownFaultOf } from "@ashara/quality";
import { parseProjectId } from "@ashara/shared";
import { classifyCellError, turnFailureOf } from "@ashara/workplace";

// Every classifier that blames a failure on a party fails closed to Ashara's own fault: an error it
// does not recognise is Ashara's to look into, never the model's, the provider's, the substrate's or
// the agent's work. A classifier that grows a default to anyone else fails here, and a new classifier
// fails until it is entered below.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000f1", "fault-classifiers.test");

class NothingNamesThis extends Error {
  constructor() {
    super("an error no classifier recognises");
    this.name = "NothingNamesThis";
  }
}

const UNKNOWN: ReadonlyArray<readonly [string, unknown]> = [
  ["a plain Error", new Error("nothing names this")],
  ["an Error class nothing names", new NothingNamesThis()],
  ["an Error whose cause nothing names", new Error("wrapper", { cause: new NothingNamesThis() })],
  ["a thrown string", "nothing names this"],
  ["a thrown object", { statusCode: 503, failure: "provider" }],
  ["undefined", undefined],
];

/** An unknown thrown value as an Error, for the classifiers that take one: the wrapper names no party either. */
function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error("a non-Error was thrown", { cause: thrown });
}

/** Each classifier's verdict on an unknown error, and the verdict that is Ashara's own fault. */
const CLASSIFIERS: Readonly<Record<string, { readonly verdict: (thrown: unknown) => string; readonly ashara: string }>> = {
  modelCallFailureOf: { verdict: (thrown) => modelCallFailureOf(thrown), ashara: "ashara" },
  modelCallBlockCategory: { verdict: (thrown) => modelCallBlockCategory(modelCallFailureOf(thrown)), ashara: "fault" },
  projectBlockCause: { verdict: (thrown) => projectBlockCause(asError(thrown)).category, ashara: "fault" },
  recordedFailureOf: { verdict: (thrown) => recordedFailureOf(thrown), ashara: "ashara" },
  exhaustedRevisionCause: {
    verdict: (thrown) => exhaustedRevisionCause(PROJECT, 3, "the last attempt's error", modelCallFailureOf(thrown)).category,
    ashara: "fault",
  },
  providerFailureOf: { verdict: (thrown) => providerFailureOf(thrown), ashara: "ashara" },
  turnFailureOf: { verdict: (thrown) => turnFailureOf(thrown), ashara: "ashara" },
  thrownFaultOf: { verdict: (thrown) => thrownFaultOf(thrown).class, ashara: "ashara" },
  environmentErrorOf: { verdict: (thrown) => (environmentErrorOf(thrown) === null ? "ashara" : "substrate"), ashara: "ashara" },
  // An unknown cell error stops the attempt (never handed to the model as its tool's error), and the
  // dispatch blames it by environmentErrorOf, as Ashara's.
  classifyCellError: {
    verdict: (thrown) => {
      const ran = classifyCellError("read_file", thrown);
      if (ran.kind !== "environment_failure") return ran.kind;
      return environmentErrorOf(ran.error) === null ? "ashara" : "substrate";
    },
    ashara: "ashara",
  },
};

/** Functions named as blame classifiers that blame no party by what they are given, with why. */
const NOT_CLASSIFIERS: Readonly<Record<string, string>> = {
  "packages/delivery/src/execution.ts#asharaFaultOf": "names Ashara's fault for every input; it reads nothing to blame",
  "packages/model-access/src/gateway.ts#structuredFailureOf": "builds the ladder's failed attempt from a response that did not validate; it blames no party",
};

const CLASSIFIER_NAME = /function (\w*(?:FailureOf|FaultOf|ErrorOf)|classify\w+|\w*BlockCause|\w*BlockCategory|\w*RevisionCause)\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("every blame classifier fails closed to Ashara's own fault", () => {
  for (const [name, classifier] of Object.entries(CLASSIFIERS)) {
    test.each(UNKNOWN)(`${name}: %s is Ashara's`, (_label, thrown) => {
      expect(classifier.verdict(thrown)).toBe(classifier.ashara);
    });
  }

  test("a stored last failure that names no party is Ashara's, and an exhausted revision read from it halts as `fault`", () => {
    for (const stored of [null, "", "ashara", "Model", "provider ", "substrate"]) {
      expect(recordedFailureOf(stored)).toBe("ashara");
      expect(exhaustedRevisionCause(PROJECT, 3, "the last attempt's error", recordedFailureOf(stored)).category).toBe("fault");
    }
  });

  test("every function named as a blame classifier is entered above", () => {
    const found: string[] = [];
    for (const pkg of readdirSync(join(ROOT, "packages")).filter((name) => name !== "integration")) {
      for (const path of sourceFiles(join(ROOT, "packages", pkg, "src"))) {
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(CLASSIFIER_NAME)) found.push(`${relative(ROOT, path)}#${match[1]}`);
      }
    }
    const unentered = found.filter((key) => NOT_CLASSIFIERS[key] === undefined && CLASSIFIERS[key.slice(key.indexOf("#") + 1)] === undefined);
    expect(unentered, "blame classifiers with no unknown-error case").toEqual([]);
    expect(Object.keys(NOT_CLASSIFIERS).filter((key) => !found.includes(key)), "exemptions no longer declared").toEqual([]);
    expect(Object.keys(CLASSIFIERS).filter((name) => !found.some((key) => key.endsWith(`#${name}`))), "entries no longer declared").toEqual([]);
  });
});

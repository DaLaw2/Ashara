import { TenderIntake } from "@ashara/engagement";
import { rewriteText } from "./faults.js";
import type { QueryPlant } from "./faults.js";

/** The method a code plant replaces is gone from TenderIntake: the plant would patch nothing and prove nothing. */
class PlantSeamMissing extends Error {
  constructor(
    readonly owner: string,
    readonly method: string,
  ) {
    super(`code plant: ${owner}.prototype.${method} is not defined, so the plant has no seam to patch`);
    this.name = "PlantSeamMissing";
  }
}

const SECOND_READING = "secondReading";

/**
 * A reading of a tender that asks the client nothing goes on with no second reading asked, as when the
 * empty question list was read as the tender being unambiguous: TenderIntake's second reading is
 * replaced by one that asks no model and reports another family's agreement, at the grade it judges.
 * Returns what undoes it.
 */
export function intakeSecondReadingDropped(): () => void {
  const original = Object.getOwnPropertyDescriptor(TenderIntake.prototype, SECOND_READING);
  if (original === undefined) throw new PlantSeamMissing("TenderIntake", SECOND_READING);
  Object.defineProperty(TenderIntake.prototype, SECOND_READING, {
    configurable: true,
    writable: true,
    value: async <Grade>(_tender: unknown, first: { readonly model: { readonly grade: Grade } }) => ({
      kind: "confirmed",
      second: {
        strength: "other-family",
        model: { provider: "planted", model: "unasked", grade: first.model.grade },
        questions: [],
      },
      passedOver: [],
    }),
  });
  return () => {
    Object.defineProperty(TenderIntake.prototype, SECOND_READING, original);
  };
}

/**
 * A contract Ashara declines is read as one it can verify: every query that asks whether the
 * project's contract in force is declined (Engagement's unverifiableContractHeld) reads no, so its
 * roster and first plan are written before the client restates it (I6's declined-work clause).
 */
export const declinedContractPlanned: QueryPlant = (args) =>
  rewriteText(args, (text) =>
    text.replaceAll("WHERE dcv.project_id = ", "WHERE FALSE AND dcv.project_id = "),
  );

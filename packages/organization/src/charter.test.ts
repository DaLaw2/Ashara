import { describe, expect, it } from "vitest";
import { charterOf } from "./charter.js";

const CONVENTIONS = { publicInterfaceFile: "INTERFACE.txt", placeholderMarker: "marker-0001" };

function duties(kind: Parameters<typeof charterOf>[0]): string {
  return charterOf(kind, CONVENTIONS).duties ?? "";
}

describe("role charters", () => {
  it("every role is a coding agent, and every kinded role carries duties beyond the task", () => {
    for (const kind of ["environment", "implementation", "check"] as const) {
      expect(charterOf(kind, CONVENTIONS).identity).toBe("You are a coding agent.");
      expect(duties(kind)).not.toBe("");
    }
  });

  it("holds the implementer to updating the public interface file it is given whenever its change makes it untrue", () => {
    const text = duties("implementation");
    expect(text).toContain("INTERFACE.txt at the repository root states the product's public interface");
    expect(text).toContain("update INTERFACE.txt in the same change, so it states the product as it then is");
    expect(text).toContain("A product is not accepted while INTERFACE.txt is still the one the product's scaffold wrote");
    expect(text).not.toContain("PUBLIC_INTERFACE.md");
  });

  it("holds the implementer to retiring the placeholder marker it is given for every entry it owns", () => {
    const text = duties("implementation");
    expect(text).toContain("refusal carrying the text marker-0001");
    expect(text).toContain("leave marker-0001 nowhere on the\n  path of an entry you own");
    expect(text).toContain("A product is not accepted while any file it tracks still holds marker-0001");
  });

  it("the environment role's charter states the recipe, the probe gate and that the product is not the environment's", () => {
    const text = duties("environment");
    for (const field of ["- containerfile:", "- recipe:", "- inputs:", "- probe:", "- build:", "- test:"]) expect(text).toContain(field);
    expect(text).not.toContain("- owned:");
    expect(text).toContain("Only recipe files may be added, changed or deleted");
    expect(text).toContain("must not build or test the product");
    expect(text).toContain("It is not run when the environment is defined");
    expect(text).toContain("the image builds and probe exits 0 within its");
    expect(text).toContain("do not write any of them, not even a placeholder");
    expect(text).not.toContain(".gitignore");
  });

  it("states the runner exactly to the check author: sh -c from the repository root, in the environment image", () => {
    const text = duties("check");
    expect(text).toContain("`sh -c '<command>'`: POSIX sh, not bash");
    expect(text).toContain("from the repository root of a fresh copy of the project, inside the project environment's image, with no network");
    expect(text).toContain("in your checks directory");
    expect(text).toContain("A check must not change any file the project tracks");
    // The cell's repository never holds the foundation's commit, so nothing names it.
    expect(text).not.toContain("names its commit");
    expect(text).toContain("define it again under the same name");
  });

  it("tells the check author its checks must not contradict the project's stored checks", () => {
    expect(duties("check")).toContain("The checks already stored for other tasks of this project");
    expect(duties("check")).toContain("yours must not contradict");
  });

  it("asks the check author for a check of what each cited item accepts and rejects, judged on the foundation", () => {
    const text = duties("check");
    expect(text).toContain("For each cited item, check what it says the product accepts and what it says the product must");
    expect(text).toContain("gives that input and requires it to be refused");
    expect(text).toContain("the project as it stood before any task of the plan did its work");
  });

  it("gives the check author one rule: test the acceptance lines, each against its cited items", () => {
    const text = duties("check");
    expect(text).toContain("Test the task's acceptance lines, listed in the Goal below, each against the vision items it cites");
    expect(text).not.toContain("deliverables and acceptance");
    expect(text).not.toContain("may test only the vision items");
    expect(text).toContain("An assumption marked internal design is how the team builds the product");
  });
});

import { describe, expect, it } from "vitest";
import { EnvironmentDefinitionInvalid, recipePaths } from "@ashara/execution-infra";
import { parseEnvironmentDefinition } from "./environment-definition.js";

const VALID = `
containerfile = "environment/Containerfile"
recipe = ["environment/setup.sh"]
inputs = ["package.json"]
probe = "make --version"
build = "make"
test = "make check"
`;

function issuesOf(text: string): readonly string[] {
  try {
    parseEnvironmentDefinition(text, "env.toml");
  } catch (err) {
    if (err instanceof EnvironmentDefinitionInvalid) return err.issues;
    throw err;
  }
  throw new Error("expected EnvironmentDefinitionInvalid");
}

describe("parseEnvironmentDefinition", () => {
  it("accepts a definition and adds nothing to it", () => {
    const definition = parseEnvironmentDefinition(VALID, "env.toml");
    expect(definition).toEqual({
      containerfile: "environment/Containerfile",
      recipe: ["environment/setup.sh"],
      inputs: ["package.json"],
      probe: "make --version",
      build: "make",
      test: "make check",
    });
    expect(recipePaths(definition)).toEqual(["environment/environment.toml", "environment/Containerfile", "environment/setup.sh"]);
  });

  it("keeps every recipe file under environment/, so a recipe can never name a product file", () => {
    expect(issuesOf(VALID.replace('"environment/setup.sh"', '"main.go"')).join("; ")).toContain(
      '"main.go" must be a file under "environment/"',
    );
    expect(issuesOf(VALID.replace('"environment/Containerfile"', '"Containerfile"')).join("; ")).toContain(
      '"Containerfile" must be a file under "environment/"',
    );
  });

  it("refuses paths that escape the repository, are absolute or name a directory", () => {
    expect(issuesOf(VALID.replace('"package.json"', '"../secrets"')).join("; ")).toContain("escapes the repository");
    expect(issuesOf(VALID.replace('"package.json"', '"/etc/passwd"')).join("; ")).toContain("is absolute");
    expect(issuesOf(VALID.replace('"package.json"', '"src/"')).join("; ")).toContain("names a directory");
  });

  it("refuses a recipe file that is also an input, extra keys and empty commands", () => {
    expect(issuesOf(VALID.replace('"package.json"', '"environment/setup.sh"')).join("; ")).toContain("recipe files cannot also be inputs");
    expect(issuesOf(`${VALID}\nowned = ["environment/"]\n`).join("; ")).toContain("owned");
    expect(issuesOf(VALID.replace('"make --version"', '"  "')).join("; ")).toContain("probe: must be a non-empty command");
  });
});

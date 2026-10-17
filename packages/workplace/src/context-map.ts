import { buildFileTree } from "@ashara/execution-infra";
import { describeErrorChain } from "@ashara/shared";
import { EMPTY_WORKDIR_CONTEXT_MAP } from "./brief-assembly.js";
import { readManifestContext } from "./dispatch-utils.js";

/**
 * Renders what can be OBSERVED about the target tree. An empty tree returns an
 * explicit statement of that emptiness rather than "" (ADR-046): "" renders as
 * no context section at all, which the agent cannot distinguish from a normal
 * project whose context happened to be omitted — so it proceeds on its prior.
 * Saying the directory is empty is what makes the frame the only thing known.
 *
 * Emptiness is said only when both reads succeeded and found nothing. A read
 * that fails is said as unavailable: a failed read is no evidence that the
 * tree is empty, and the brief must not tell the agent that it is.
 *
 * The tree is cell-writable, so every read goes through tree-read.ts, and no
 * manifest format is known here: the top-level files speak for themselves.
 */
export async function buildContextMap(targetProjectPath: string): Promise<string> {
  const sections: string[] = ["# Project Context"];
  const unavailable: string[] = [];

  try {
    const tree = await buildFileTree(targetProjectPath, 4, 200);
    if (tree) {
      sections.push("## File Tree\n" + tree);
    }
  } catch (e: unknown) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: the file tree is listed under Not Available in the brief, never stated as empty
    console.warn(`[buildContextMap] Failed to build file tree for ${targetProjectPath}: ${describeErrorChain(e)}`);
    unavailable.push("- the file tree: reading it failed");
  }

  try {
    const manifestContent = await readManifestContext(targetProjectPath);
    if (manifestContent) {
      sections.push(`## Project Manifests\n${manifestContent}`);
    }
  } catch (e: unknown) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: the top-level files are listed under Not Available in the brief, never stated as empty
    console.warn(`[buildContextMap] Failed to read manifests in ${targetProjectPath}: ${describeErrorChain(e)}`);
    unavailable.push("- the top-level files: reading them failed");
  }

  if (unavailable.length > 0) {
    sections.push(
      [
        "## Not Available",
        "Ashara could not read these parts of the working directory, so nothing about them is stated here;",
        "they may hold files. Use read_file and list_directory to see what is there.",
        ...unavailable,
      ].join("\n"),
    );
  }

  return sections.length > 1 ? sections.join("\n\n") : EMPTY_WORKDIR_CONTEXT_MAP;
}

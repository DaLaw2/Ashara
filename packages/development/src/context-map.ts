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
 * The tree is cell-writable, so every read goes through tree-read.ts, and no
 * manifest format is known here: the top-level files speak for themselves.
 */
export async function buildContextMap(targetProjectPath: string | null): Promise<string> {
  if (!targetProjectPath) return EMPTY_WORKDIR_CONTEXT_MAP;

  const sections: string[] = ["# Project Context"];

  try {
    const tree = await buildFileTree(targetProjectPath, 4, 200);
    if (tree) {
      sections.push("## File Tree\n" + tree);
    }
  } catch (e: unknown) {
    console.warn(`[buildContextMap] Failed to build file tree for ${targetProjectPath}: ${describeErrorChain(e)}`);
  }

  try {
    const manifestContent = await readManifestContext(targetProjectPath);
    if (manifestContent) {
      sections.push(`## Project Manifests\n${manifestContent}`);
    }
  } catch (e: unknown) {
    console.warn(`[buildContextMap] Failed to read manifests in ${targetProjectPath}: ${describeErrorChain(e)}`);
  }

  return sections.length > 1 ? sections.join("\n\n") : EMPTY_WORKDIR_CONTEXT_MAP;
}

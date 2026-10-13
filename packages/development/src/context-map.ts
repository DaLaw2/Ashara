import { EMPTY_WORKDIR_CONTEXT_MAP } from "./brief-assembly.js";
import { readManifestContext } from "./dispatch-utils.js";
import { readTreeFile } from "./tree-read.js";
import { buildFileTree } from "./workspace.js";

const ENTRY_POINT_HEAD_LINES = 50;
const ENTRY_POINT_HEAD_BYTES = 64 * 1024;

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
export async function buildContextMap(
  targetProjectPath: string | null,
  contractEntryPointPath?: string,
): Promise<string> {
  if (!targetProjectPath) return EMPTY_WORKDIR_CONTEXT_MAP;

  const sections: string[] = ["# Project Context"];

  try {
    const tree = await buildFileTree(targetProjectPath, 4, 200);
    if (tree) {
      sections.push("## File Tree\n" + tree);
    }
  } catch (e: unknown) {
    console.warn(`[buildContextMap] Failed to build file tree for ${targetProjectPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const manifestContent = await readManifestContext(targetProjectPath);
    if (manifestContent) {
      sections.push(`## Project Manifests\n${manifestContent}`);
    }
  } catch (e: unknown) {
    console.warn(`[buildContextMap] Failed to read manifests in ${targetProjectPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (contractEntryPointPath) {
    try {
      const read = await readTreeFile(targetProjectPath, contractEntryPointPath, ENTRY_POINT_HEAD_BYTES);
      if (read.kind === "file") {
        const head = read.text.split("\n").slice(0, ENTRY_POINT_HEAD_LINES).join("\n");
        sections.push(`## Entry Point (${contractEntryPointPath})\n\`\`\`\n${head}\n\`\`\``);
      } else {
        console.warn(`[buildContextMap] Entry point ${contractEntryPointPath} does not exist in ${targetProjectPath}`);
      }
    } catch (e: unknown) {
      console.warn(`[buildContextMap] Failed to read entry point ${contractEntryPointPath} in ${targetProjectPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return sections.length > 1 ? sections.join("\n\n") : EMPTY_WORKDIR_CONTEXT_MAP;
}

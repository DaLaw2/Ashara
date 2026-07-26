/**
 * Ashara's control directory inside an agent workspace. It holds run-internal
 * artifacts (brief.json, output.json, conversation.jsonl, tool-overflow/) that
 * belong to Ashara, never to the product being built — so it must never count
 * as agent output nor reach the target repository's history.
 */
export const ASHARA_CONTROL_DIR = ".ashara";

const CONTROL_DIR_PREFIX = `${ASHARA_CONTROL_DIR}/`;

/**
 * True for any repository-relative path inside {@link ASHARA_CONTROL_DIR}.
 * Git reports the untracked directory as `.ashara/` but already-tracked files
 * inside it individually (`.ashara/brief.json`), so both shapes must match.
 */
export function isAsharaControlPath(repoRelativePath: string): boolean {
  return repoRelativePath === ASHARA_CONTROL_DIR || repoRelativePath.startsWith(CONTROL_DIR_PREFIX);
}

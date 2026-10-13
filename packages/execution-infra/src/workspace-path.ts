import { posix } from "node:path";
import { PathOutsideWorkspace } from "./errors.js";

export const WORKSPACE_ROOT = "/workspace";

/**
 * Normalizes a workspace-relative path and returns it as "./<path>" (or "."), so no utility can
 * read it as an option. The check is lexical; symlinks resolve inside the cell, where the only
 * filesystem reachable is the cell's own.
 */
export function toWorkspaceRelative(path: string): string {
  if (path.includes("\0")) throw new PathOutsideWorkspace(path, "contains a NUL byte");
  if (path.startsWith("/")) throw new PathOutsideWorkspace(path, "absolute paths are not accepted");
  const normalized = posix.normalize(path === "" ? "." : path).replace(/\/+$/, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new PathOutsideWorkspace(path, "escapes the workspace through '..'");
  }
  return normalized === "." || normalized === "" ? "." : `./${normalized}`;
}

export function toWorkspaceAbsolute(path: string): string {
  const relative = toWorkspaceRelative(path);
  return relative === "." ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${relative.slice(2)}`;
}

/** Inverse of toWorkspaceRelative for paths printed by find/grep inside the cell. */
export function stripDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

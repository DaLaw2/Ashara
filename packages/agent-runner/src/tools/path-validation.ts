import { resolve, normalize, isAbsolute } from "node:path";

/**
 * Validate and resolve a path within a sandboxed working directory.
 *
 * Rules:
 *  - Absolute paths are rejected
 *  - Paths that escape workingDir via ".." are rejected
 *  - Returns the resolved absolute path on success, null on failure
 */
export function validatePath(inputPath: string, workingDir: string): string | null {
    if (isAbsolute(inputPath)) {
        return null;
    }

    const resolved = resolve(workingDir, normalize(inputPath));

    // Ensure the resolved path is within (or equal to) workingDir
    const normalizedBase = resolve(workingDir);
    if (!resolved.startsWith(normalizedBase + "/") && resolved !== normalizedBase) {
        return null;
    }

    return resolved;
}

/**
 * Extract JSON from an LLM response that may contain markdown fences,
 * explanatory text, truncated output, or other non-JSON content.
 */
export function extractJson(text: string): string {
    const trimmed = text.trim();

    // Fast path: already valid JSON
    try {
        JSON.parse(trimmed);
        return trimmed;
    } catch (e: unknown) {
        if (!(e instanceof SyntaxError)) throw e;
    }

    // Strip markdown code fences: ```json\n...\n``` or ```\n...\n```
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
        const fenced = fenceMatch[1]!.trim();
        return tryParseOrRepair(fenced) ?? fenced;
    }

    // Find first { or [ and match to last } or ]
    const jsonStart = trimmed.search(/[{[]/);
    if (jsonStart >= 0) {
        const startChar = trimmed[jsonStart];
        const endChar = startChar === "{" ? "}" : "]";
        const lastEnd = trimmed.lastIndexOf(endChar);
        if (lastEnd > jsonStart) {
            const candidate = trimmed.slice(jsonStart, lastEnd + 1);
            return tryParseOrRepair(candidate) ?? candidate;
        }
        // No matching close bracket — likely truncated. Try repair from jsonStart.
        const truncated = trimmed.slice(jsonStart);
        const repaired = repairTruncatedJson(truncated);
        if (repaired !== null) {
            return repaired;
        }
    }

    // Return as-is so the caller sees the original parse error
    return trimmed;
}

function tryParseOrRepair(candidate: string): string | null {
    try {
        JSON.parse(candidate);
        return candidate;
    } catch {
        // Try to repair truncated JSON
        return repairTruncatedJson(candidate);
    }
}

function repairTruncatedJson(text: string): string | null {
    let inString = false;
    let escaped = false;
    const stack: string[] = [];

    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            if (inString) escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;

        if (ch === "{") stack.push("}");
        else if (ch === "[") stack.push("]");
        else if (ch === "}" || ch === "]") {
            if (stack.length > 0 && stack[stack.length - 1] === ch) {
                stack.pop();
            }
        }
    }

    if (stack.length === 0) return null;

    // Close any open string
    let suffix = "";
    if (inString) {
        suffix += '"';
    }

    // Append missing closing brackets in reverse order
    while (stack.length > 0) {
        suffix += stack.pop();
    }

    const repaired = text + suffix;
    try {
        JSON.parse(repaired);
        return repaired;
    } catch {
        return null;
    }
}

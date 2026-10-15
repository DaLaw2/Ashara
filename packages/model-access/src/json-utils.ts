/**
 * The JSON text of an LLM response that may wrap it in a markdown fence or in
 * explanatory prose. It only removes what surrounds the value and never adds
 * a character: a truncated value stays unparseable, so the caller sees the
 * parse error instead of a value the model never finished.
 */
export function extractJson(text: string): string {
    const trimmed = text.trim();

    if (parses(trimmed)) return trimmed;

    // Strip markdown code fences: ```json\n...\n``` or ```\n...\n```
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) return fenceMatch[1]!.trim();

    // Prose around the value: from the first { or [ to the last matching close.
    const jsonStart = trimmed.search(/[{[]/);
    if (jsonStart >= 0) {
        const endChar = trimmed[jsonStart] === "{" ? "}" : "]";
        const lastEnd = trimmed.lastIndexOf(endChar);
        if (lastEnd > jsonStart) return trimmed.slice(jsonStart, lastEnd + 1);
    }

    // As-is, so the caller sees the original parse error.
    return trimmed;
}

function parses(candidate: string): boolean {
    try {
        JSON.parse(candidate);
        return true;
    } catch (e: unknown) {
        if (e instanceof SyntaxError) return false;
        throw e;
    }
}

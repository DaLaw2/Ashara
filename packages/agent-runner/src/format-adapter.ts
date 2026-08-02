export interface ResponseToolCall {
    readonly id: string;
    readonly name: string;
    // open-by-design: LLM-authored tool arguments, shape varies per tool
    readonly input: Record<string, unknown>;
}

export interface ParseableResponse {
    readonly content: string;
    readonly toolCalls?: readonly ResponseToolCall[];
}

export interface FileWrite {
    readonly path: string;
    readonly content: string;
    readonly action: "create" | "update" | "delete";
}

export interface ParsedResponse {
    readonly toolCalls: readonly ResponseToolCall[];
    readonly fileWrites: FileWrite[];
}

export interface FormatAdapter {
    readonly name: string;
    parseResponse(response: ParseableResponse): ParsedResponse;
}

export class NativeFCAdapter implements FormatAdapter {
    readonly name = "native-fc";

    parseResponse(response: ParseableResponse): ParsedResponse {
        const toolCalls = response.toolCalls ?? [];
        if (toolCalls.length > 0) {
            return { toolCalls, fileWrites: [] };
        }
        if (response.content && /^```\w/m.test(response.content)) {
            console.warn("[NativeFCAdapter] no tool calls but code fences detected, falling back to CodeFenceAdapter");
            const fileWrites = parseCodeFences(response.content);
            if (fileWrites.length > 0) {
                return { toolCalls: [], fileWrites };
            }
        }
        return { toolCalls: [], fileWrites: [] };
    }
}

export class CodeFenceAdapter implements FormatAdapter {
    readonly name = "code-fence";

    parseResponse(response: ParseableResponse): ParsedResponse {
        const toolCalls = response.toolCalls ?? [];
        if (toolCalls.length > 0) {
            return { toolCalls, fileWrites: [] };
        }

        const fileWrites = parseCodeFences(response.content);
        return { toolCalls: [], fileWrites };
    }
}

// --- Code Fence Parser ---

function extractFencedBlocks(text: string): Array<{ lang: string; rawContent: string; fenceStart: number }> {
    const blocks: Array<{ lang: string; rawContent: string; fenceStart: number }> = [];
    const lines = text.split("\n");
    let i = 0;

    while (i < lines.length) {
        const openMatch = lines[i].match(/^(`{3,})([\w+\-]*(?::[^\n]*)?)\s*$/);
        if (!openMatch) {
            i++;
            continue;
        }

        const backtickLen = openMatch[1].length;
        const langTag = openMatch[2];
        const fenceStart = i;
        const closePattern = "`".repeat(backtickLen);
        const contentLines: string[] = [];
        i++;

        while (i < lines.length) {
            if (lines[i].trim() === closePattern) {
                break;
            }
            contentLines.push(lines[i]);
            i++;
        }

        blocks.push({ lang: langTag, rawContent: contentLines.join("\n") + "\n", fenceStart });
        i++;
    }

    return blocks;
}

export function parseCodeFences(text: string): FileWrite[] {
    const writes: FileWrite[] = [];
    const seen = new Set<string>();
    const textLines = text.split("\n");
    const blocks = extractFencedBlocks(text);

    for (const block of blocks) {
        let path: string | undefined;

        const colonIdx = block.lang.indexOf(":");
        if (colonIdx !== -1) {
            path = block.lang.slice(colonIdx + 1).trim();
        }

        if (!path) {
            const contentLines = block.rawContent.split("\n");
            if (contentLines.length > 0) {
                const commentMatch = contentLines[0].match(/^(?:\/\/|#|--|\/\*)\s*filepath:\s*(.+?)(?:\s*\*\/)?$/);
                if (commentMatch) {
                    path = commentMatch[1].trim();
                    block.rawContent = contentLines.slice(1).join("\n");
                }
            }
        }

        if (!path && block.fenceStart > 0) {
            const prevLine = textLines[block.fenceStart - 1].trim();
            const boldMatch = prevLine.match(/^\*\*([^*]+)\*\*$/);
            if (boldMatch) {
                const candidate = boldMatch[1].trim();
                if (candidate.includes("/") || candidate.includes(".")) {
                    path = candidate;
                }
            }
        }

        if (!path || seen.has(path)) continue;
        seen.add(path);

        let content = block.rawContent;
        if (content.endsWith("\n")) {
            content = content.slice(0, -1);
        }

        writes.push({ path, content, action: "create" });
    }

    return writes;
}


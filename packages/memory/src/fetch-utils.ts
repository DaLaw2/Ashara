const DEFAULT_TIMEOUT_MS = 30_000;
const EMBED_TIMEOUT_MS = 60_000;

function getTimeoutMs(envVar: string, defaultMs: number): number {
    const val = process.env[envVar];
    return val ? parseInt(val, 10) || defaultMs : defaultMs;
}

export async function fetchWithTimeout(
    url: string | URL,
    options: RequestInit = {},
    timeoutMs?: number,
): Promise<Response> {
    const ms = timeoutMs ?? getTimeoutMs("ASHARA_HTTP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

export function getEmbedTimeoutMs(): number {
    return getTimeoutMs("ASHARA_EMBED_TIMEOUT_MS", EMBED_TIMEOUT_MS);
}

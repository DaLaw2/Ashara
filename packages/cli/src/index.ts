#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Ashara CLI — entry point
// ---------------------------------------------------------------------------

import { z } from "zod";
import { NoLLMProvidersConfigured } from "@ashara/llm-gateway";
import { runVision, VisionError } from "./commands/vision.js";
import { ClientError } from "./client.js";

const NO_INTERACT_FLAG = "--no-interact";
const CLIENT_FLAG = "--client";
const USAGE = `Usage: ashara vision ${CLIENT_FLAG} <client-id> '<description>' [${NO_INTERACT_FLAG}]`;

/**
 * Splits the `vision` subcommand's argv tail into the free-text vision
 * description, the `--no-interact` flag (ADR-019 explicit mode override) and
 * `--client <id>`, the client the project is created for (migration 018: every
 * project has one, and there is no default). Flags can appear anywhere among the
 * words since they are removed before the remaining words are joined back into
 * the description.
 */
function parseVisionArgs(args: readonly string[]): {
    visionText: string;
    noInteract: boolean;
    clientId: string | null;
} {
    let noInteract = false;
    let clientId: string | null = null;
    const words: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === NO_INTERACT_FLAG) {
            noInteract = true;
        } else if (arg === CLIENT_FLAG) {
            const parsed = z.uuid().safeParse(args[i + 1]);
            clientId = parsed.success ? parsed.data : null;
            i++;
        } else {
            words.push(arg);
        }
    }
    return { visionText: words.join(" "), noInteract, clientId };
}

/** Result of mapping a thrown error to CLI output: lines to print on stderr, and the exit code. */
interface CliErrorResult {
    readonly exitCode: number;
    readonly lines: readonly string[];
}

/**
 * Maps an error caught from `runVision` to the stderr lines and exit code the CLI should
 * produce. Extracted from `main()` so it can be unit-tested without invoking `process.exit`.
 */
function handleCliError(err: unknown): CliErrorResult {
    if (err instanceof NoLLMProvidersConfigured) {
        return {
            exitCode: 1,
            lines: [`[ashara] ${err.message}`, `[ashara] How to fix: ${err.howToFix}`],
        };
    }
    if (err instanceof VisionError) {
        return { exitCode: 1, lines: [`[ashara] ${err.kind}: ${err.message}`] };
    }
    if (err instanceof ClientError) {
        return { exitCode: 1, lines: [`[ashara] Server error (${err.kind}): ${err.message}`] };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, lines: [`[ashara] Unexpected error: ${message}`] };
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0];

    if (command === "vision") {
        const { visionText, noInteract, clientId } = parseVisionArgs(args.slice(1));
        if (!visionText || clientId === null) {
            console.error(USAGE);
            if (clientId === null) console.error(`${CLIENT_FLAG} <client-id> is required and must be a UUID.`);
            process.exit(1);
        }

        try {
            const exitCode = await runVision(visionText, { noInteract, clientId });
            process.exit(exitCode);
        } catch (err) {
            const { exitCode, lines } = handleCliError(err);
            for (const line of lines) {
                console.error(line);
            }
            process.exit(exitCode);
        }
    } else if (command === "--help" || command === "-h") {
        printUsage();
        process.exit(0);
    } else if (command === undefined) {
        printUsage();
        process.exit(0);
    } else {
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
}

function printUsage(): void {
    console.log("Ashara -- Autonomous Development System");
    console.log("");
    console.log("Commands:");
    console.log(`  vision ${CLIENT_FLAG} <client-id> '<description>'`);
    console.log("                          -- Build software from a vision, for that client");
    console.log("");
    console.log("Options:");
    console.log("  --help, -h              -- Show this help");
    console.log(`  ${CLIENT_FLAG} <client-id>    -- Required: the client the project belongs to`);
    console.log("                             (npx tsx scripts/client.ts list)");
    console.log(`  ${NO_INTERACT_FLAG}          -- Skip interactive Q&A; unanswered questions stay open`);
    console.log("                             (default mode selection otherwise follows TTY detection)");
    console.log("");
    console.log("Environment:");
    console.log("  ASHARA_SERVER_URL       -- Server URL (default: http://localhost:3000)");
}

if (import.meta.main) {
    main();
}

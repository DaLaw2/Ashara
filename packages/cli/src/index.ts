#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Ashara CLI — entry point
// ---------------------------------------------------------------------------

import { NoLLMProvidersConfigured } from "@ashara/llm-gateway";
import { runVision, VisionError } from "./commands/vision.js";
import { ClientError } from "./client.js";

const NO_INTERACT_FLAG = "--no-interact";

/**
 * Splits the `vision` subcommand's argv tail into the free-text vision
 * description and the `--no-interact` flag (ADR-019 explicit mode override).
 * The flag can appear anywhere among the words (before, after, or between)
 * since it is filtered out before the remaining words are joined back into
 * the description. Extracted so the parsing itself is unit-testable without
 * invoking `process.exit`.
 */
function parseVisionArgs(args: readonly string[]): { visionText: string; noInteract: boolean } {
    const noInteract = args.includes(NO_INTERACT_FLAG);
    const visionText = args.filter((a) => a !== NO_INTERACT_FLAG).join(" ");
    return { visionText, noInteract };
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
        const { visionText, noInteract } = parseVisionArgs(args.slice(1));
        if (!visionText) {
            console.error(`Usage: ashara vision '<description>' [${NO_INTERACT_FLAG}]`);
            process.exit(1);
        }

        try {
            const exitCode = await runVision(visionText, { noInteract });
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
    console.log("  vision '<description>'  -- Build software from a vision");
    console.log("");
    console.log("Options:");
    console.log("  --help, -h              -- Show this help");
    console.log(`  ${NO_INTERACT_FLAG}          -- Skip interactive Q&A; unanswered questions stay open`);
    console.log("                             (default mode selection otherwise follows TTY detection)");
    console.log("");
    console.log("Environment:");
    console.log("  ASHARA_SERVER_URL       -- Server URL (default: http://localhost:3000)");
}

if (import.meta.main) {
    main();
}

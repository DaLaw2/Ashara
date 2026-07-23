/**
 * ProjectContract → task-relevant brief slice (mig-phase-9 t3).
 *
 * The ProjectContract (ADR-028) is the machine-readable cross-task spec: which
 * endpoints exist behind which prefixes, which modules a task must import rather
 * than recreate, and how the entry point mounts everything. Run 9 failed because
 * agents could not see any of this — they recreated modules and guessed type
 * shapes. This module renders the part of the contract that matters to ONE task
 * into a brief section the agent prompt can carry.
 *
 * The Development BC never imports @ashara/db: the concrete contract is supplied
 * through the {@link ContractSource} port, while the slicing itself is this pure,
 * deterministic function.
 *
 * Export-shape source: the contract's own module registry (`path` / `purpose` /
 * `exports`). We deliberately do NOT read the target tree from disk here — that
 * would couple a pure renderer to a filesystem and is explicitly optional for this
 * task. If richer signatures are wanted later they belong behind the port.
 */

import type { ProjectContract, ProjectKnowledge, Endpoint, ContractModule, Mount } from "@ashara/shared";
import { nodesByKind } from "@ashara/shared";

/**
 * Port that yields the current ProjectContract for the project a task belongs to,
 * or null when the project has no contract (legacy / contract-less runs). Injected
 * into DevelopmentService so the BC stays free of any db dependency (ADR-027); the
 * composition root resolves task → project → latest contract.
 */
export interface ContractSource {
    loadForTask(taskId: string): Promise<ProjectContract | null>;
    /**
     * Given the `declaredBy` task ids of a contract's endpoints, returns the subset
     * that have actually completed. Used to label sibling endpoints in
     * {@link formatContractSlice} — completed endpoints appear as "already built"
     * conventions to follow, while non-completed endpoints appear as "planned"
     * routes to prepare mounts for. Optional: when absent, all non-self endpoints
     * are shown as "planned" (conservative — nothing is assumed to be built).
     */
    loadCompletedTaskIds?(taskIds: readonly string[]): Promise<ReadonlySet<string>>;
}

const TECH_STACK_KINDS = ["language", "runtime", "framework", "database", "build_tool"] as const;

function formatTechStack(knowledge: ProjectKnowledge): string | undefined {
    const lines: string[] = [];
    for (const kind of TECH_STACK_KINDS) {
        for (const node of nodesByKind(knowledge, kind)) {
            lines.push(`- ${kind}: ${node.label}`);
        }
    }
    return lines.length > 0 ? ["## Project Tech Stack", ...lines].join("\n") : undefined;
}

function mountPrefixByRef(mounts: readonly Mount[]): ReadonlyMap<string, string> {
    const byRef = new Map<string, string>();
    for (const m of mounts) {
        if (!byRef.has(m.endpointRef)) byRef.set(m.endpointRef, m.mountedAt);
    }
    return byRef;
}

function formatEndpointLine(endpoint: Endpoint, prefix: string | undefined): string {
    const mounted = prefix ? ` (mounted at ${prefix})` : "";
    return `- ${endpoint.method} ${endpoint.path}${mounted} — ${endpoint.purpose}`;
}

function formatModuleLines(module: ContractModule): string[] {
    const lines = [`- ${module.path} — ${module.purpose}`];
    if (module.exports && module.exports.length > 0) {
        lines.push(`  exports: ${module.exports.join(", ")}`);
    }
    return lines;
}

/**
 * Renders the slice of `contract` relevant to `taskId`, or undefined when nothing
 * applies to this task. Returning undefined (rather than an empty section) keeps a
 * brief byte-identical when a contract exists but has nothing to say to the task,
 * and lets callers omit the field entirely when there is no contract at all.
 *
 * Sections:
 *  - Endpoints this task must expose: endpoints whose `declaredBy` is this task,
 *    each with the concrete prefix it is mounted behind.
 *  - Endpoints already built by other tasks: endpoints declared by a DIFFERENT,
 *    COMPLETED sibling task — the cross-task visibility signal (granularity-debate.md
 *    §3.A) that lets an agent see and follow a naming convention a sibling already
 *    established (e.g. `/api/auth/*`) instead of guessing a divergent one.
 *  - Endpoints planned by other tasks: endpoints declared by a DIFFERENT,
 *    NON-COMPLETED sibling task — lets wiring/scaffold tasks prepare mounts for
 *    routes that are planned but not yet delivered.
 *  - Existing modules to reuse: every `reuseOnly` module this task does not itself
 *    provide, with its export shape — the anti-recreate list (Run 9 lever).
 *  - Entry-point wiring to preserve: the full mount manifest, so a task editing the
 *    entry point keeps existing mounts instead of clobbering them.
 */
export function formatContractSlice(
    contract: ProjectContract,
    taskId: string,
    completedTaskIds?: ReadonlySet<string>,
): string | undefined {
    const prefixByRef = mountPrefixByRef(contract.mounts);

    const endpointsToExpose = contract.endpoints.filter((e) => e.declaredBy === taskId);

    const builtEndpoints: Endpoint[] = [];
    const plannedEndpoints: Endpoint[] = [];
    for (const e of contract.endpoints) {
        if (e.declaredBy === undefined || e.declaredBy === taskId) continue;
        if (completedTaskIds?.has(e.declaredBy)) {
            builtEndpoints.push(e);
        } else {
            plannedEndpoints.push(e);
        }
    }

    const reuseModules = contract.modules.filter(
        (m) => m.reuseOnly && m.providerWorkItem !== taskId,
    );
    const mounts = contract.mounts;

    const techStack = formatTechStack(contract.knowledge);

    if (
        endpointsToExpose.length === 0 &&
        builtEndpoints.length === 0 &&
        plannedEndpoints.length === 0 &&
        reuseModules.length === 0 &&
        mounts.length === 0 &&
        !techStack
    ) {
        return undefined;
    }

    const sections: string[] = ["# Project Contract (shared cross-task spec — honor it)"];

    if (techStack) {
        sections.push(techStack);
    }

    if (endpointsToExpose.length > 0) {
        sections.push(
            [
                "## Endpoints this task must expose",
                ...endpointsToExpose.map((e) => formatEndpointLine(e, prefixByRef.get(e.ref))),
            ].join("\n"),
        );
    }

    if (builtEndpoints.length > 0) {
        sections.push(
            [
                "## Endpoints already built by other tasks (follow these conventions)",
                ...builtEndpoints.map((e) => formatEndpointLine(e, prefixByRef.get(e.ref))),
            ].join("\n"),
        );
    }

    if (plannedEndpoints.length > 0) {
        sections.push(
            [
                "## Endpoints planned by other tasks (prepare mounts for these)",
                ...plannedEndpoints.map((e) => formatEndpointLine(e, prefixByRef.get(e.ref))),
            ].join("\n"),
        );
    }

    if (reuseModules.length > 0) {
        sections.push(
            [
                "## Existing modules — import these, do NOT recreate them",
                ...reuseModules.flatMap(formatModuleLines),
            ].join("\n"),
        );
    }

    if (mounts.length > 0) {
        sections.push(
            [
                "## Entry-point wiring to preserve",
                ...mounts.map((m) => `- ${m.endpointRef} mounted at ${m.mountedAt}`),
            ].join("\n"),
        );
    }

    return sections.join("\n\n");
}

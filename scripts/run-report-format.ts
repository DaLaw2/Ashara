/**
 * The text of a run report (scripts/run-report.ts) from a project's run evidence. Pure: no
 * database, no environment, nothing that could carry a secret.
 */

import type { readRunEvidence } from "@ashara/workplace";

type RunEvidence = Awaited<ReturnType<typeof readRunEvidence>>;
type CallTotals = RunEvidence["calls"][number];
type Session = RunEvidence["tasks"][number]["sessions"][number];

interface Totals {
  calls: number;
  measuredCalls: number;
  measuredUsd: number;
  unmeasuredEstimateUsd: number;
  pendingCalls: number;
  lostCalls: number;
  zeroCostCalls: number;
  cacheCountedCalls: number;
  inputTokens: number;
  cacheReadTokens: number;
}

function emptyTotals(): Totals {
  return { calls: 0, measuredCalls: 0, measuredUsd: 0, unmeasuredEstimateUsd: 0, pendingCalls: 0, lostCalls: 0, zeroCostCalls: 0, cacheCountedCalls: 0, inputTokens: 0, cacheReadTokens: 0 };
}

function addTo(sum: Totals, row: Totals): void {
  sum.calls += row.calls;
  sum.measuredCalls += row.measuredCalls;
  sum.measuredUsd += row.measuredUsd;
  sum.unmeasuredEstimateUsd += row.unmeasuredEstimateUsd;
  sum.pendingCalls += row.pendingCalls;
  sum.lostCalls += row.lostCalls;
  sum.zeroCostCalls += row.zeroCostCalls;
  sum.cacheCountedCalls += row.cacheCountedCalls;
  sum.inputTokens += row.inputTokens;
  sum.cacheReadTokens += row.cacheReadTokens;
}

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

/** Never a 0% read off missing counts: no call that reported both counts is "unknown", not "no hits". */
function cacheShare(t: Totals): string {
  if (t.cacheCountedCalls === 0) return "cache-hit share unknown (no call reported both input and cache-read tokens)";
  if (t.inputTokens === 0) return `cache-hit share undefined (0 input tokens over ${t.cacheCountedCalls} call(s))`;
  const share = ((100 * t.cacheReadTokens) / t.inputTokens).toFixed(1);
  const uncounted = t.calls - t.cacheCountedCalls;
  return (
    `cache-hit share ${share}% (${t.cacheReadTokens} cache-read of ${t.inputTokens} input tokens over ${t.cacheCountedCalls} call(s)` +
    `${uncounted > 0 ? `; ${uncounted} call(s) without both counts excluded` : ""})`
  );
}

/** Which unmeasured calls never returned to their record: an admitted call is not a call with an unknown price. */
function unmeasuredDetail(t: Totals, unmeasured: number): string {
  const parts = [
    ...(t.pendingCalls > 0 ? [`${t.pendingCalls} admitted and not yet recorded`] : []),
    ...(t.lostCalls > 0 ? [`${t.lostCalls} admitted by a process that ended before recording them`] : []),
  ];
  const returned = unmeasured - t.pendingCalls - t.lostCalls;
  if (parts.length === 0) return "";
  return `: ${[...parts, ...(returned > 0 ? [`${returned} recorded with no cost measured`] : [])].join(", ")}`;
}

function costLine(t: Totals): string {
  const unmeasured = t.calls - t.measuredCalls;
  return (
    `${t.calls} call(s), cost measured on ${t.measuredCalls}/${t.calls}: ${usd(t.measuredUsd)}` +
    `${unmeasured > 0 ? `; ${unmeasured} unmeasured (worst-case estimate ${usd(t.unmeasuredEstimateUsd)}${unmeasuredDetail(t, unmeasured)})` : ""}` +
    `${t.zeroCostCalls > 0 ? `; ${t.zeroCostCalls} PRICED AT $0` : ""}`
  );
}

/** A session without recorded attempt columns is "no attempt recorded", with what its row shows; never "no model call". */
function sessionLine(index: number, s: Session): string {
  const head = `    ${index}. session ${s.sessionId} (${s.phase}, ${s.createdAt.toISOString()})`;
  const record = s.attempt;
  switch (record.kind) {
    case "recorded": {
      const a = record.attempt;
      const environment = a.cell === "base-cell" ? "base cell" : `environment ${s.environmentVersion ?? "MISSING"}`;
      return `${head}: terminal ${a.terminal}, ${a.turns} turn(s), model ${a.provider}/${a.model}, ${environment}, prompt digest ${a.promptDigest}`;
    }
    case "open":
      return `${head}: no attempt recorded; the session is not terminal (in flight, or a crash orphan not yet reconciled)`;
    case "reconciled":
      return `${head}: no attempt recorded; closed by ${record.by} as a crash orphan, so any model calls it made are untracked`;
    case "predates-attempt-columns":
      return `${head}: no attempt recorded; the session predates migration 046, which added the attempt columns`;
    case "completed-without-attempt":
      return (
        `${head}: no attempt; it completed without one, and its end record reads: ` +
        `${record.endDetail ?? "(no detail written: the row predates completions recording one)"}`
      );
    case "unrecorded":
      return (
        `${head}: no attempt recorded; it ended (${record.endOutcome ?? "no end outcome written"}) without an attempt outcome ` +
        `(before the model, or its attempt threw)`
      );
  }
}

/**
 * Whether a session's model calls, if it made any, can never be tied to an attempt: it ended, or
 * was closed, with no attempt recorded, and its row does not show whether it called a model before
 * it did. That includes a session that completed without an attempt: its row records the end, not
 * the absence of a call. An open session is not: it is in flight, and its calls precede the attempt
 * record it has yet to write.
 */
function mayHoldUntiedCalls(s: Session): boolean {
  switch (s.attempt.kind) {
    case "reconciled":
    case "predates-attempt-columns":
    case "unrecorded":
    case "completed-without-attempt":
      return true;
    case "recorded":
    case "open":
      return false;
  }
}

function callLines(rows: readonly CallTotals[]): string[] {
  if (rows.length === 0) return ["    (no llm_calls rows)"];
  return rows.map((row) => `    ${row.provider}: ${costLine(row)}; ${cacheShare(row)}`);
}

export function formatRunReport(evidence: RunEvidence): { readonly text: string; readonly zeroCostCalls: number } {
  const { project, tasks, calls } = evidence;
  const lines: string[] = [`run-report: project ${project.name} (${project.id}), status ${project.status}`];
  const overall = emptyTotals();
  const byProvider = new Map<string, Totals>();
  for (const row of calls) {
    addTo(overall, row);
    const sum = byProvider.get(row.provider) ?? emptyTotals();
    addTo(sum, row);
    byProvider.set(row.provider, sum);
  }

  let attempts = 0;
  let sessions = 0;
  let untiedTasks = 0;
  for (const task of tasks) {
    lines.push("", `task ${task.taskId} [${task.status}] ${task.title}`, "  attempts:");
    if (task.sessions.length === 0) lines.push("    (no dev session)");
    task.sessions.forEach((s, i) => {
      sessions += 1;
      if (s.attempt.kind === "recorded") attempts += 1;
      lines.push(sessionLine(i + 1, s));
    });
    const taskCalls = calls.filter((row) => row.taskId === task.taskId);
    lines.push("  llm_calls:", ...callLines(taskCalls));
    const untied = task.sessions.filter(mayHoldUntiedCalls).length;
    const inFlight = task.sessions.filter((s) => s.attempt.kind === "open").length;
    const callCount = taskCalls.reduce((sum, row) => sum + row.calls, 0);
    if (untied > 0 && callCount > 0) {
      untiedTasks += 1;
      lines.push(
        `  UNTIED: ${callCount} llm_calls row(s) on this task and ${untied} session(s) that ended without a recorded attempt; ` +
          "those calls cannot be tied to an attempt",
      );
    } else if (task.sessions.length === 0 && callCount > 0) {
      // A dispatch that runs no agent, such as a review of the plan's suites, opens no dev session.
      untiedTasks += 1;
      lines.push(`  UNTIED: ${callCount} llm_calls row(s) on this task and no dev session; those calls cannot be tied to an attempt`);
    }
    if (inFlight > 0 && callCount > 0) {
      lines.push(`  in flight: ${inFlight} session(s) not yet terminal; their calls are tied once their attempt is recorded`);
    }
  }
  const projectCalls = calls.filter((row) => row.taskId === null);
  if (projectCalls.length > 0) lines.push("", "project calls (no task):", ...callLines(projectCalls));

  lines.push("", "totals:", `  ${sessions} dev session(s), ${attempts} with a recorded attempt, ${sessions - attempts} without; ${untiedTasks} task(s) UNTIED`, `  all providers: ${costLine(overall)}`);
  for (const [provider, sum] of [...byProvider.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    lines.push(`  ${provider}: ${cacheShare(sum)}`);
  }
  if (overall.zeroCostCalls > 0) {
    lines.push("", `VIOLATION: ${overall.zeroCostCalls} llm_calls row(s) priced at exactly $0; an unknown cost must be NULL, never $0`);
  }
  return { text: lines.join("\n"), zeroCostCalls: overall.zeroCostCalls };
}

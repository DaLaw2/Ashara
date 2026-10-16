/**
 * The text of a run report (scripts/run-report.ts) from a project's run evidence. Pure: no
 * database, no environment, nothing that could carry a secret.
 */

import type { readRunEvidence } from "@ashara/workplace";

type RunEvidence = Awaited<ReturnType<typeof readRunEvidence>>;
type CallTotals = RunEvidence["calls"][number];
type Session = RunEvidence["tasks"][number]["sessions"][number];
type TaskCall = RunEvidence["tasks"][number]["calls"][number];

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
      return `${head}: no attempt recorded; closed by ${record.by} as a crash orphan, so any agent call it made is tied to no attempt`;
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
 * Which attempt an agent call belongs to, read from when it was admitted: `tied` inside a session
 * with a recorded attempt (from the session's creation to its terminal write), `open` at or after
 * the start of a session not yet terminal, and `untied` otherwise: it matches no attempt, whatever
 * the task's other sessions show. An `open` call is tied to no attempt the rows show; whether one
 * will be is not in them: the session is in flight, or a crash orphan the startup reconciler has
 * not closed, whose calls then stay tied to none.
 */
function tieOf(call: TaskCall, sessions: readonly Session[]): "tied" | "open" | "untied" {
  const at = call.createdAt.getTime();
  const within = (s: Session) => s.createdAt.getTime() <= at && at <= s.updatedAt.getTime();
  if (sessions.some((s) => s.attempt.kind === "recorded" && within(s))) return "tied";
  if (sessions.some((s) => s.attempt.kind === "open" && s.createdAt.getTime() <= at)) return "open";
  return "untied";
}

/** The per-task lines on how its calls tie to its attempts, and whether any is UNTIED. */
function tieLines(task: RunEvidence["tasks"][number]): { readonly lines: string[]; readonly untied: boolean } {
  const lines: string[] = [];
  const agentCalls = task.calls.filter((c) => c.agentTurn);
  const ties = agentCalls.map((c) => ({ call: c, tie: tieOf(c, task.sessions) }));
  const untied = ties.filter((t) => t.tie === "untied").map((t) => t.call.createdAt.toISOString());
  const open = ties.filter((t) => t.tie === "open").length;
  if (untied.length > 0) {
    lines.push(
      `  UNTIED: ${untied.length} of ${agentCalls.length} agent call(s) on this task fall in no session with a recorded attempt ` +
        `(admitted ${untied.length === 1 ? `at ${untied[0]}` : `from ${untied[0]} to ${untied[untied.length - 1]}`}); those calls cannot be tied to an attempt`,
    );
  }
  if (open > 0) {
    lines.push(
      `  open: ${open} agent call(s) admitted in a session not yet terminal (in flight, or a crash orphan not yet reconciled); ` +
        `no attempt is recorded for it, so none is tied to an attempt yet`,
    );
  }
  const bySite = new Map<string, number>();
  for (const c of task.calls) if (!c.agentTurn) bySite.set(c.callSite, (bySite.get(c.callSite) ?? 0) + 1);
  for (const [site, n] of [...bySite.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    lines.push(`  ${n} call(s) by ${site}: not an attempt's turn (an attempt calls only as agent-runner), so none is tied to an attempt`);
  }
  return { lines, untied: untied.length > 0 };
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
    const tie = tieLines(task);
    if (tie.untied) untiedTasks += 1;
    lines.push(...tie.lines);
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

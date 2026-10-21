/**
 * The text of a run report (scripts/run-report.ts) from a project's run evidence. Pure: no
 * database, no environment, nothing that could carry a secret.
 */

import { z } from "zod";
import { isGoalTask } from "@ashara/delivery/predicates";
import type { lastReportGuaranteeVerdictsOf } from "@ashara/engagement";
import type { ReviewerRecordLine, StoredClaim, StoredJudgement } from "@ashara/quality";
import type { readRunEvidence } from "@ashara/workplace";
import type { JudgedVerdict, Overall } from "./hidden-verdict.js";
import type { MappingFile, PacketKey } from "./pool-mapping.js";
import type { PickRecord } from "./pool-selection.js";

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
      return `${head}: no attempt recorded; the session predates the attempt columns`;
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
  // eslint-disable-next-line no-restricted-syntax -- policy default: a call site not yet counted has count 0, the accumulator's start
  for (const c of task.calls) if (!c.agentTurn) bySite.set(c.callSite, (bySite.get(c.callSite) ?? 0) + 1);
  for (const [site, n] of [...bySite.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    lines.push(`  ${n} call(s) by ${site}: not an attempt's turn (an attempt calls only as agent-runner), so none is tied to an attempt`);
  }
  return { lines, untied: untied.length > 0 };
}

/**
 * A call's context utilisation, its input tokens over its model's window. Never 0%
 * read off a missing count: a call whose provider reported no input tokens, or whose row records no
 * window, is unknown, with why.
 */
type Utilisation = { readonly kind: "known"; readonly share: number; readonly input: number; readonly window: number } | { readonly kind: "unknown"; readonly why: string };

function utilisationOf(call: TaskCall): Utilisation {
  if (call.inputTokens === null) return { kind: "unknown", why: "no input tokens reported" };
  if (call.contextWindowTokens === null) return { kind: "unknown", why: "no window recorded (a row recorded before windows were, or not recorded yet)" };
  return { kind: "known", share: call.inputTokens / call.contextWindowTokens, input: call.inputTokens, window: call.contextWindowTokens };
}

function percent(share: number): string {
  return `${(100 * share).toFixed(1)}%`;
}

function utilisationText(u: Utilisation): string {
  return u.kind === "known" ? `${percent(u.share)} (${u.input} of ${u.window} tokens)` : `unknown (${u.why})`;
}

/** Each of the task's calls with its context utilisation, in the order they were admitted. */
function utilisationLines(task: RunEvidence["tasks"][number]): string[] {
  if (task.calls.length === 0) return [];
  return [
    "  context utilisation per call (input tokens over the model's window):",
    ...task.calls.map((c) => `    ${c.createdAt.toISOString()} ${c.callSite}: ${utilisationText(utilisationOf(c))}`),
  ];
}

/** The highest utilisation of an Epic's calls, and how many were known and unknown. */
interface PeakUtilisation {
  peak: { readonly share: number; readonly at: string } | null;
  known: number;
  unknown: number;
}

function addUtilisation(sum: PeakUtilisation, calls: readonly TaskCall[]): void {
  for (const c of calls) {
    const u = utilisationOf(c);
    if (u.kind === "unknown") {
      sum.unknown += 1;
      continue;
    }
    sum.known += 1;
    if (sum.peak === null || u.share > sum.peak.share) sum.peak = { share: u.share, at: `${c.createdAt.toISOString()} ${c.callSite}` };
  }
}

function peakText(p: PeakUtilisation): string {
  if (p.peak === null) return `peak context utilisation unknown (no call of ${p.unknown} has a known utilisation)`;
  const unknown = p.unknown > 0 ? `; ${p.unknown} call(s) of unknown utilisation excluded` : "";
  return `peak context utilisation ${percent(p.peak.share)} (call ${p.peak.at}) over ${p.known} call(s)${unknown}`;
}

type WorkItem = RunEvidence["workItems"][number];

/** Measured spend over a set of llm_calls rows; an unmeasured row is counted, never read as $0. */
interface Spend {
  usd: number;
  calls: number;
  unmeasured: number;
}

function noSpend(): Spend {
  return { usd: 0, calls: 0, unmeasured: 0 };
}

function addSpend(sum: Spend, calls: readonly TaskCall[]): void {
  for (const c of calls) {
    sum.calls += 1;
    if (c.costUsd === null) sum.unmeasured += 1;
    else sum.usd += c.costUsd;
  }
}

function spendText(s: Spend): string {
  return `${usd(s.usd)}${s.unmeasured > 0 ? ` (${s.unmeasured} of ${s.calls} call(s) unmeasured, not in this figure)` : ""}`;
}

/**
 * The goal task an item's spend serves, or why none. A goal task (isGoalTask, the one definition)
 * serves itself; a check task serves the task its task_spec.checksFor names; an environment change
 * serves the task its work_items.repairs_task_id records it was opened for. A link
 * not on record, or one naming no goal task of the project, serves none and says so. Anything else
 * serves no goal task.
 */
type Served = { readonly kind: "goal"; readonly goal: WorkItem; readonly as: "own" | "check" | "repair" } | { readonly kind: "none"; readonly why: string };

function servedBy(item: WorkItem, items: ReadonlyMap<string, WorkItem>): Served {
  if (isGoalTask(item)) return { kind: "goal", goal: item, as: "own" };
  if (item.workKind === "check" && item.origin === "check") {
    if (item.checksFor === null) return { kind: "none", why: "check task with no task_spec.checksFor" };
    const checked = items.get(item.checksFor);
    if (checked === undefined || !isGoalTask(checked)) return { kind: "none", why: `check task whose checksFor ${item.checksFor} is no goal task of the project` };
    return { kind: "goal", goal: checked, as: "check" };
  }
  if (item.origin === "environment-change") {
    if (item.repairsTaskId === null) return { kind: "none", why: "environment change with no work_items.repairs_task_id on record (created before the link was recorded)" };
    const repaired = items.get(item.repairsTaskId);
    if (repaired === undefined || !isGoalTask(repaired)) return { kind: "none", why: `environment change whose repairs_task_id ${item.repairsTaskId} is no goal task of the project` };
    return { kind: "goal", goal: repaired, as: "repair" };
  }
  if (item.workKind === "implementation" && item.origin === null) return { kind: "none", why: "implementation task with no recorded task_spec.origin" };
  return { kind: "none", why: `${item.workKind ?? "no work kind"}${item.origin === null ? "" : ` (${item.origin})`}` };
}

/** The Epic an item sits under by its work_items.parent_id chain, or null when the chain reaches none. */
function epicOf(item: WorkItem, items: ReadonlyMap<string, WorkItem>): WorkItem | null {
  const seen = new Set<string>();
  let at: WorkItem | undefined = item;
  while (at !== undefined && !seen.has(at.id)) {
    if (at.level === "Epic") return at;
    seen.add(at.id);
    at = at.parentId === null ? undefined : items.get(at.parentId);
  }
  return null;
}

interface GoalSpend {
  readonly goal: WorkItem;
  readonly first: Spend;
  readonly rework: Spend;
  readonly checks: Spend;
  readonly repairs: Spend;
}

interface EpicSpend {
  readonly epic: WorkItem | null;
  readonly goals: GoalSpend[];
  readonly unattributed: { readonly item: WorkItem; readonly why: string; readonly spend: Spend }[];
  agentCalls: number;
  agentCallsWithInput: number;
  agentInputTokens: number;
  readonly utilisation: PeakUtilisation;
}

function total(...parts: readonly Spend[]): Spend {
  return parts.reduce((sum, p) => ({ usd: sum.usd + p.usd, calls: sum.calls + p.calls, unmeasured: sum.unmeasured + p.unmeasured }), noSpend());
}

function epicTotal(e: EpicSpend): Spend {
  return total(...e.goals.flatMap((g) => [g.first, g.rework, g.checks, g.repairs]), ...e.unattributed.map((u) => u.spend));
}

function perGoal(spend: Spend, goals: number): string {
  return goals === 0 ? "per goal task undefined (no goal task)" : `${usd(spend.usd / goals)} per goal task`;
}

/**
 * Spend per Epic and per goal task, and mean input tokens per agent call and the peak
 * context utilisation of any call per Epic. Each task's spend is charged to the goal task it serves (servedBy) in that goal task's
 * Epic; a goal task's calls from its second dev session on are its rework. Spend that serves no
 * goal task is printed on its Epic's unattributed line, and llm_calls with no task on the project-level
 * line, never dropped or spread; the Epics' totals and the project-level line are checked to add up to
 * every llm_calls row of the project.
 */
function costLines(evidence: RunEvidence, overall: Totals): { readonly lines: string[]; readonly violation: boolean } {
  const items = new Map(evidence.workItems.map((w) => [w.id, w]));
  const epics = new Map<string | null, EpicSpend>();
  const epicFor = (epic: WorkItem | null): EpicSpend => {
    const key = epic === null ? null : epic.id;
    const known = epics.get(key);
    if (known !== undefined) return known;
    const created: EpicSpend = { epic, goals: [], unattributed: [], agentCalls: 0, agentCallsWithInput: 0, agentInputTokens: 0, utilisation: { peak: null, known: 0, unknown: 0 } };
    epics.set(key, created);
    return created;
  };
  for (const w of evidence.workItems) if (w.level === "Epic") epicFor(w);
  const goals = new Map<string, GoalSpend>();
  for (const w of evidence.workItems) {
    if (!isGoalTask(w)) continue;
    const g: GoalSpend = { goal: w, first: noSpend(), rework: noSpend(), checks: noSpend(), repairs: noSpend() };
    goals.set(w.id, g);
    epicFor(epicOf(w, items)).goals.push(g);
  }

  const lines: string[] = [];
  const orphanTasks: string[] = [];
  for (const task of evidence.tasks) {
    const item = items.get(task.taskId);
    if (item === undefined) {
      orphanTasks.push(task.taskId);
      continue;
    }
    const served = servedBy(item, items);
    const goal = served.kind === "goal" ? goals.get(served.goal.id) : undefined;
    const bucket = epicFor(epicOf(goal === undefined ? item : goal.goal, items));
    addUtilisation(bucket.utilisation, task.calls);
    for (const c of task.calls) {
      if (!c.agentTurn) continue;
      bucket.agentCalls += 1;
      if (c.inputTokens !== null) {
        bucket.agentCallsWithInput += 1;
        bucket.agentInputTokens += c.inputTokens;
      }
    }
    if (served.kind === "none" || goal === undefined) {
      if (task.calls.length === 0) continue;
      const spend = noSpend();
      addSpend(spend, task.calls);
      bucket.unattributed.push({ item, why: served.kind === "none" ? served.why : "goal task not on record", spend });
      continue;
    }
    if (served.as === "check") addSpend(goal.checks, task.calls);
    else if (served.as === "repair") addSpend(goal.repairs, task.calls);
    else {
      const [, second] = task.sessions;
      const reworkFrom = second === undefined ? null : second.createdAt.getTime();
      addSpend(goal.first, task.calls.filter((c) => reworkFrom === null || c.createdAt.getTime() < reworkFrom));
      addSpend(goal.rework, task.calls.filter((c) => reworkFrom !== null && c.createdAt.getTime() >= reworkFrom));
    }
  }

  lines.push(
    "",
    "cost per Epic and goal task (measured cost_usd; a goal task is a task with work_items.level 'Task' and " +
      "task_spec.origin 'decomposition'; its check tasks by task_spec.checksFor, its environment changes by work_items.repairs_task_id, " +
      "its rework as its calls from its second dev session on; Epic by the work_items.parent_id chain; " +
      "project-level spend, llm_calls with no task, is in no Epic and has its own line):",
  );
  let attributed = noSpend();
  let unattributed = noSpend();
  let inEpics = noSpend();
  let goalCount = 0;
  for (const e of epics.values()) {
    if (e.epic === null && e.goals.length === 0 && e.unattributed.length === 0 && e.agentCalls === 0) continue;
    const spend = epicTotal(e);
    inEpics = total(inEpics, spend);
    const input =
      e.agentCallsWithInput === 0
        ? `mean input tokens per agent call unknown (no agent call of ${e.agentCalls} reported input tokens)`
        : `mean input tokens per agent call ${Math.round(e.agentInputTokens / e.agentCallsWithInput)} (${e.agentInputTokens} over ${e.agentCallsWithInput} call(s)` +
          `${e.agentCalls > e.agentCallsWithInput ? `; ${e.agentCalls - e.agentCallsWithInput} without input tokens excluded` : ""})`;
    const name = e.epic === null ? "(no Epic: the parent_id chain reaches none)" : `${e.epic.id} ${e.epic.title}`;
    lines.push(`  Epic ${name}: spend ${spendText(spend)} over ${e.goals.length} goal task(s), ${perGoal(spend, e.goals.length)}; ${input}; ${peakText(e.utilisation)}`);
    goalCount += e.goals.length;
    for (const g of e.goals) {
      const own = total(g.first, g.rework);
      const charged = total(g.checks, g.repairs);
      attributed = total(attributed, own, charged);
      lines.push(
        `    goal task ${g.goal.id} [${g.goal.status}] ${g.goal.title}: own ${spendText(own)} (first session ${usd(g.first.usd)}, rework ${usd(g.rework.usd)}); ` +
          `charged ${spendText(charged)} (checks ${usd(g.checks.usd)}, repairs ${usd(g.repairs.usd)}); total ${usd(own.usd + charged.usd)}`,
      );
    }
    if (e.unattributed.length > 0) {
      const sum = total(...e.unattributed.map((u) => u.spend));
      unattributed = total(unattributed, sum);
      lines.push(
        `    unattributed: ${spendText(sum)}, serving no goal task: ` + e.unattributed.map((u) => `${u.item.id} ${u.why} ${usd(u.spend.usd)}`).join("; "),
      );
    }
  }
  const projectCalls = evidence.calls.filter((row) => row.taskId === null);
  const project: Spend = {
    usd: projectCalls.reduce((sum, row) => sum + row.measuredUsd, 0),
    calls: projectCalls.reduce((sum, row) => sum + row.calls, 0),
    unmeasured: projectCalls.reduce((sum, row) => sum + row.calls - row.measuredCalls, 0),
  };
  lines.push(`  project-level (llm_calls with no task, in no Epic): spend ${spendText(project)} over ${project.calls} call(s)`);
  lines.push(
    `  run: spend ${spendText({ usd: overall.measuredUsd, calls: overall.calls, unmeasured: overall.calls - overall.measuredCalls })} over ${goalCount} goal task(s), ${perGoal({ usd: overall.measuredUsd, calls: 0, unmeasured: 0 }, goalCount)}; ` +
      `in Epics ${usd(inEpics.usd)} (charged to goal tasks ${usd(attributed.usd)}, unattributed ${usd(unattributed.usd)}), project-level ${usd(project.usd)}`,
  );
  const accounted = inEpics.calls + project.calls;
  const accountedUsd = inEpics.usd + project.usd;
  const violation = orphanTasks.length > 0 || accounted !== overall.calls || Math.abs(accountedUsd - overall.measuredUsd) > 1e-9;
  if (violation) {
    lines.push(
      `  VIOLATION: the Epics and the project-level line account for ${accounted} of ${overall.calls} llm_calls row(s) and ${usd(accountedUsd)} of ${usd(overall.measuredUsd)}` +
        `${orphanTasks.length > 0 ? `; task(s) ${orphanTasks.join(", ")} are no work item of the project` : ""}`,
    );
  }
  return { lines, violation };
}

function callLines(rows: readonly CallTotals[]): string[] {
  if (rows.length === 0) return ["    (no llm_calls rows)"];
  return rows.map((row) => `    ${row.provider}: ${costLine(row)}; ${cacheShare(row)}`);
}

export function formatRunReport(evidence: RunEvidence): { readonly text: string; readonly zeroCostCalls: number; readonly attributionViolation: boolean } {
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
    lines.push(...utilisationLines(task));
  }
  const projectCalls = calls.filter((row) => row.taskId === null);
  if (projectCalls.length > 0) lines.push("", "project calls (no task):", ...callLines(projectCalls));

  lines.push("", "totals:", `  ${sessions} dev session(s), ${attempts} with a recorded attempt, ${sessions - attempts} without; ${untiedTasks} task(s) UNTIED`, `  all providers: ${costLine(overall)}`);
  for (const [provider, sum] of [...byProvider.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    lines.push(`  ${provider}: ${cacheShare(sum)}`);
  }
  const cost = costLines(evidence, overall);
  lines.push(...cost.lines);
  if (overall.zeroCostCalls > 0) {
    lines.push("", `VIOLATION: ${overall.zeroCostCalls} llm_calls row(s) priced at exactly $0; an unknown cost must be NULL, never $0`);
  }
  return { text: lines.join("\n"), zeroCostCalls: overall.zeroCostCalls, attributionViolation: cost.violation };
}

/** A reader's mapping of the run's Ashara arm, and the packet key that joins its item labels to Ashara's guarantee ids. */
export interface GuaranteeMapping {
  readonly file: MappingFile;
  readonly key: PacketKey;
}

/** The hidden suite's verdict, the pool's pick record and the guarantee mapping a run report is given, each or none. */
export interface PoolEvidence {
  readonly hidden: JudgedVerdict | null;
  readonly pick: PickRecord | null;
  readonly mapping: GuaranteeMapping | null;
}

/**
 * One acceptance sweep as stored: its verdict and the commit it ran on. A passed sweep always names its commit, so a
 * passed row without one is malformed, not an acceptance of an unknown tree. A commit is a full object id.
 */
const sweepCommit = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/, "a full commit id");
const acceptanceSweepSchema = z.discriminatedUnion("passed", [
  z.object({ passed: z.literal(true), mainCommit: sweepCommit, createdAt: z.date() }),
  z.object({ passed: z.literal(false), mainCommit: sweepCommit.nullable(), createdAt: z.date() }),
]);

/** Ashara's verdict on the project: its most recent acceptance sweep, or none when no sweep is recorded. */
type AsharaVerdict = z.output<typeof acceptanceSweepSchema> | null;

/** A stored acceptance sweep that does not read as one; the report would otherwise state a verdict nobody recorded. */
class AcceptanceSweepUnreadable extends Error {
  readonly projectId: string;
  readonly issues: readonly string[];

  constructor(projectId: string, issues: readonly string[], options?: ErrorOptions) {
    super(`run-report: the latest acceptance_sweeps row of project ${projectId} does not read as a sweep: ${issues.join("; ")}`, options);
    this.name = "AcceptanceSweepUnreadable";
    this.projectId = projectId;
    this.issues = issues;
  }
}

/**
 * Ashara's verdict from the project's most recent acceptance sweep row, as read from the database (undefined when it
 * has none). Throws AcceptanceSweepUnreadable for a row of another shape.
 */
export function asharaVerdictOf(projectId: string, row: unknown): AsharaVerdict {
  if (row === undefined) return null;
  const parsed = acceptanceSweepSchema.safeParse(row);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`);
  throw new AcceptanceSweepUnreadable(projectId, issues, { cause: parsed.error });
}

function asharaText(verdict: AsharaVerdict): string {
  if (verdict === null) return "Ashara gave no acceptance verdict (no acceptance sweep recorded)";
  if (verdict.passed) return `Ashara Accepted (sweep on ${verdict.mainCommit})`;
  return `Ashara Rejected (sweep failed on ${verdict.mainCommit ?? "no recorded commit"})`;
}

/**
 * Whether the two verdicts agree. A disagreement is Ashara accepting what the hidden suite does not pass, or rejecting
 * what it passes; a pair that cannot disagree but does not agree either is named as not compared, with why.
 */
function comparison(verdict: AsharaVerdict, overall: Overall): string {
  if (verdict === null) return "not compared: Ashara gave no acceptance verdict";
  if (verdict.passed) return overall === "pass" ? "agree" : "DISAGREE";
  if (overall === "pass") return "DISAGREE";
  return overall === "fail" ? "agree" : "not compared: the hidden suite is incomplete";
}

/**
 * The pool lines a run report prints after its first line: the tender pick (id, seed, reason) and Ashara's verdict
 * beside the hidden suite's, every guarantee named. No verdict file reads "hidden suite: not run", never a pass; a
 * verdict file for another tender than the pick is a violation.
 */
export function formatPoolVerdicts(verdict: AsharaVerdict, pool: PoolEvidence): { readonly lines: string[]; readonly violation: boolean } {
  const { hidden, pick } = pool;
  const pickLine =
    pick === null
      ? "tender pick: not recorded (run-report was given no --run)"
      : `tender pick: ${pick.tender} seed ${pick.seed} (${pick.reason}; run ${pick.run}, commit ${pick.commit})`;
  const ashara = asharaText(verdict);
  if (hidden === null) return { lines: [pickLine, `verdicts: ${ashara} | hidden suite: not run`], violation: false };
  const passed = hidden.guarantees.filter((entry) => entry.verdict === "pass").length;
  const guarantees = hidden.guarantees.map((entry) => `${entry.id} ${entry.verdict}`).join(", ");
  const seed = pick === null ? "seed not recorded" : `seed ${pick.seed.slice(0, 12)}`;
  const lines = [
    pickLine,
    `verdicts: ${ashara} | hidden suite ${hidden.tender} ${seed}: ${hidden.overall.toUpperCase()} ${passed}/${hidden.guarantees.length} pass, ${guarantees} | ${comparison(verdict, hidden.overall)}`,
  ];
  const mismatch = pick !== null && pick.tender !== hidden.tender;
  if (mismatch) lines.push(`VIOLATION: the hidden verdict judges tender ${hidden.tender}, the run picked ${pick.tender}`);
  return { lines, violation: mismatch };
}

const storedVerdictFields = { reportId: z.string().min(1), guaranteeId: z.string().min(1), evidenceClass: z.string().min(1) };
const storedGuaranteeVerdictSchema = z.discriminatedUnion("verdict", [
  z.strictObject({ ...storedVerdictFields, verdict: z.enum(["pass", "fail"]), reason: z.null() }),
  z.strictObject({ ...storedVerdictFields, verdict: z.literal("unjudged"), reason: z.string().min(1) }),
]);
export type StoredGuaranteeVerdict = z.output<typeof storedGuaranteeVerdictSchema>;

/** The project's last terminal report as the database holds it: none, one carrying no verdict rows, or one with its rows unparsed. */
type LastTerminalReport = Awaited<ReturnType<typeof lastReportGuaranteeVerdictsOf>>;

/**
 * Ashara's per-guarantee verdicts: those its last terminal report carries; or that its last terminal report carries
 * none; or that it has no terminal report.
 */
export type AsharaGuarantees =
  | { readonly kind: "no-terminal-report" }
  | { readonly kind: "no-verdicts"; readonly reportId: string }
  | { readonly kind: "report"; readonly reportId: string; readonly byId: ReadonlyMap<string, StoredGuaranteeVerdict> };

/** The guarantee_verdicts rows of a project's last terminal report do not read as one report's table. */
class GuaranteeVerdictsUnreadable extends Error {
  readonly projectId: string;
  readonly issues: readonly string[];

  constructor(projectId: string, issues: readonly string[], options?: ErrorOptions) {
    super(`run-report: the guarantee_verdicts rows of project ${projectId}'s last terminal report do not read as its table: ${issues.join("; ")}`, options);
    this.name = "GuaranteeVerdictsUnreadable";
    this.projectId = projectId;
    this.issues = issues;
  }
}

/**
 * Ashara's per-guarantee verdicts from the guarantee_verdicts rows of the project's last terminal report, as read from
 * the database. Throws GuaranteeVerdictsUnreadable for rows of another shape, of a report other than the last terminal
 * one, or naming a guarantee twice.
 */
export function asharaGuaranteesOf(projectId: string, last: LastTerminalReport): AsharaGuarantees {
  if (last.kind !== "verdicts") return last;
  const parsed = z.array(storedGuaranteeVerdictSchema).nonempty().safeParse(last.rows);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`);
    throw new GuaranteeVerdictsUnreadable(projectId, issues, { cause: parsed.error });
  }
  const byId = new Map<string, StoredGuaranteeVerdict>();
  for (const row of parsed.data) {
    if (row.reportId !== last.reportId) throw new GuaranteeVerdictsUnreadable(projectId, [`a row of report ${row.reportId}, not of the last terminal report ${last.reportId}`]);
    if (byId.has(row.guaranteeId)) throw new GuaranteeVerdictsUnreadable(projectId, [`guarantee ${row.guaranteeId} twice`]);
    byId.set(row.guaranteeId, row);
  }
  return { kind: "report", reportId: last.reportId, byId };
}

/** Where Ashara's side of the pairs is read from, in the report's words. */
function asharaSource(ashara: AsharaGuarantees): string {
  switch (ashara.kind) {
    case "report":
      return `terminal report ${ashara.reportId}`;
    case "no-verdicts":
      return `terminal report ${ashara.reportId}, which carries no guarantee verdicts`;
    case "no-terminal-report":
      return "no terminal report on record";
  }
}

function asharaItemText(row: StoredGuaranteeVerdict): string {
  if (row.verdict === "unjudged") return `${row.guaranteeId} unjudged (${row.reason};${row.evidenceClass})`;
  return `${row.guaranteeId} ${row.verdict} (${row.evidenceClass})`;
}

/**
 * What Ashara said of one intended guarantee over the items mapped to it: fail when any of them failed, pass when every
 * one passed, unjudged otherwise.
 */
export function asharaClaim(rows: readonly StoredGuaranteeVerdict[]): "pass" | "fail" | "unjudged" {
  if (rows.some((row) => row.verdict === "fail")) return "fail";
  return rows.every((row) => row.verdict === "pass") ? "pass" : "unjudged";
}

type HiddenSide = JudgedVerdict["guarantees"][number]["verdict"] | "not run" | "not judged";

/**
 * One pair's outcome. An intended guarantee no item covers is omitted; a narrowed one Ashara reported as passing is a
 * false confirm whatever the hidden suite says, since Ashara confirmed a weaker promise than the intended one; a pass
 * over a hidden fail is a false confirm too.
 */
function pairOutcome(rows: readonly StoredGuaranteeVerdict[], narrowed: boolean, hidden: HiddenSide): string {
  if (rows.length === 0) return "omitted";
  const claim = asharaClaim(rows);
  if (claim === "pass" && narrowed) return "false-confirm";
  if (hidden === "not run") return "not compared: the hidden suite was not run";
  if (hidden === "not judged") return "not compared: the hidden suite did not judge it";
  if (hidden === "unjudged") return "not compared: the hidden suite left it unjudged";
  if (claim === "unjudged") return "not compared: Ashara left it unjudged";
  if (claim === hidden) return "agree";
  return claim === "pass" ? "false-confirm" : "DISAGREE";
}

/**
 * One Ashara/hidden pair per intended guarantee of the mapping: the Ashara guarantees its items join to through the
 * key, each with its verdict and evidence class from the last terminal report, beside the hidden suite's verdict. No
 * mapping prints "pairs: not mapped", never a pair. A key of another run or arm, a label the key does not hold, or an
 * item whose guarantee the report gives no verdict is a violation, and no pair is printed.
 */
export function formatGuaranteePairs(ashara: AsharaGuarantees, pool: PoolEvidence): { readonly lines: string[]; readonly violation: boolean } {
  const { mapping, hidden, pick } = pool;
  if (mapping === null) return { lines: ["pairs: not mapped"], violation: false };
  const { file, key } = mapping;
  const problems: string[] = [];
  if (key.run !== file.run) problems.push(`the packet key is of run ${key.run}, the mapping of run ${file.run}`);
  if (key.arm !== "ashara") problems.push(`the packet key is of the ${key.arm} arm, not Ashara's`);
  const idOf = new Map(key.items.map((item) => [item.label, item.id]));
  const pairs = file.map.map((entry) => ({
    entry,
    rows: entry.to.flatMap((label) => {
      const id = idOf.get(label);
      if (id === undefined) {
        problems.push(`${entry.intended} maps to ${label}, which the packet key does not hold`);
        return [];
      }
      const row = ashara.kind === "report" ? ashara.byId.get(id) : undefined;
      if (row === undefined) {
        problems.push(`${entry.intended} maps to ${label} (${id}), to which ${ashara.kind === "no-terminal-report" ? "no terminal report on record" : "the last terminal report"} gives no verdict`);
        return [];
      }
      return [row];
    }),
  }));
  if (problems.length > 0) return { lines: ["pairs: not compared", ...problems.map((problem) => `VIOLATION: ${problem}`)], violation: true };
  const tender = hidden?.tender ?? pick?.tender;
  const lines = [`pairs (mapping of run ${file.run}; ${asharaSource(ashara)}):`];
  for (const { entry, rows } of pairs) {
    const judged = hidden?.guarantees.find((guarantee) => guarantee.id === entry.intended);
    const hiddenSide: HiddenSide = hidden === null ? "not run" : (judged?.verdict ?? "not judged");
    const asharaSide = rows.length === 0 ? "Ashara none" : `Ashara ${rows.map(asharaItemText).join(", ")}${entry.narrowed ? ", narrowed" : ""}`;
    lines.push(`  ${tender === undefined ? "" : `${tender}/`}${entry.intended} <- ${asharaSide} | hidden ${hiddenSide} | ${pairOutcome(rows, entry.narrowed, hiddenSide)}`);
  }
  return { lines, violation: false };
}

/** One finding of a suite review, as the report states it. */
function findingLine(finding: StoredJudgement["secondFindings"][number]): string {
  switch (finding.kind) {
    case "outside-vision":
      return `missing "${finding.missingClause}": ${finding.problem}`;
    case "undecided-item":
      return `undecided ${finding.item}: ${finding.problem}`;
    case "contradiction":
      return `contradiction${finding.conflict === undefined ? "" : ` (${[finding.conflict.first, finding.conflict.second].map((side) => `"${side.check}" of ${side.checkTask} requires "${side.requires}"`).join("; ")})`}: ${finding.problem}`;
  }
}

type Strength = Extract<StoredClaim["second"], { readonly kind: "answered" }>["strength"];

/** What each strength of second opinion was, as the report names it. */
const STRENGTH_TEXT: Readonly<Record<Strength, string>> = {
  "other-family": "another model family",
  "same-family-other-model": "another model of the family",
  "same-model": "the same model from another angle",
};

/** The reviews a judgement or claim rests on: the first, and the second opinion where one answered. */
interface Reviews {
  readonly first: string;
  readonly second: { readonly model: string; readonly strength: Strength } | null;
}

/**
 * Which review an equal judge tier rests on was graded at the work's tier, from each review's grade
 * as stored; a row that does not record both reviews' grades says only that one of them was.
 */
function equalReason(tiers: Extract<StoredJudgement["tiers"], { readonly kind: "recorded" }>, reviews: Reviews): string {
  const first = `the first review, ${reviews.first}`;
  if (reviews.second === null) return `${first}, the only review it rests on, was graded at the work's tier`;
  const second = `the second opinion, from ${STRENGTH_TEXT[reviews.second.strength]}, ${reviews.second.model}`;
  const graded = tiers.reviews;
  if (graded.kind === "ungraded" || graded.second === null) return `it rests on ${first}, and ${second}; which of them was graded at the work's tier is not on record`;
  const firstAt = graded.first === tiers.judged;
  const secondAt = graded.second === tiers.judged;
  if (firstAt && secondAt) return `both reviews were graded at the work's tier: ${first}, and ${second}`;
  if (secondAt) return `${second}, was graded ${graded.second}; ${first}, was graded ${graded.first}, above it`;
  return `${first}, was graded ${graded.first}; ${second}, was graded ${graded.second}, above it`;
}

/**
 * How a judgement's or claim's judges stood to the check work they judged: the weaker judge's grade
 * against the work's tier, with an equal relation named as no stronger than the work and which review was.
 */
function tiersLine(tiers: StoredJudgement["tiers"], reviews: Reviews): string {
  if (tiers.kind === "unrecorded") return "    judge tier: not recorded (written before judge tiers were)";
  if (tiers.relation === "above") return `    judge tier: ${tiers.judge}, above the check work at ${tiers.judged}`;
  return `    judge tier: EQUAL: ${tiers.judge}, no stronger than the check work at ${tiers.judged} (${equalReason(tiers, reviews)})`;
}

/**
 * The suite reviews' judgements on every finding of their first pass, routed, released or kept as
 * advisory, each with why, how its judges stood to the check work, both reviews' findings whole, the
 * second review's strength (or none asked), and every strength it passed over before it answered or failed.
 */
export function formatSuiteReviewJudgements(judgements: readonly StoredJudgement[]): string {
  if (judgements.length === 0) return "Suite review judgements: none recorded";
  const lines = [`Suite review judgements (${judgements.length}):`];
  for (const judgement of judgements) {
    const subject = judgement.checkName === null ? `its ${judgement.firstFinding.kind} finding` : `check "${judgement.checkName}"`;
    const second =
      judgement.secondFailure !== null
        ? `second review failed (first ${judgement.firstModel}): ${judgement.secondFailure}`
        : judgement.secondStrength === null
          ? "no second review asked"
          : `second review ${judgement.secondStrength} (first ${judgement.firstModel}, second ${judgement.secondModel})`;
    lines.push(
      `  review ${judgement.reviewTaskId}, ${subject} of task ${judgement.checkTaskId}: ${judgement.outcome} (${judgement.basis}); ${second}`,
      tiersLine(judgement.tiers, {
        first: judgement.firstModel,
        second: judgement.secondModel === null || judgement.secondStrength === null ? null : { model: judgement.secondModel, strength: judgement.secondStrength },
      }),
      ...judgement.passedOver.map((over) => `    passed over ${over.strength} (${over.outcome}): ${over.reason}`),
      `    first review:  ${findingLine(judgement.firstFinding)}`,
    );
    if (judgement.secondStrength !== null && judgement.secondFindings.length === 0) lines.push("    second review: no finding on this check task");
    for (const finding of judgement.secondFindings) lines.push(`    second review: ${findingLine(finding)}`);
  }
  return lines.join("\n");
}

/** What each claim basis leaves of the claim, and why an item it leaves undecided reads unverified. */
const CLAIM_BASIS: Readonly<Record<StoredClaim["basis"], { readonly label: string; readonly unverified: string }>> = {
  "second-opinion-clean": { label: "clean: the second opinion found no problem either", unverified: "a clean claim leaves no item unverified" },
  "second-opinion-found": { label: "finding: the second opinion found a problem", unverified: "the second opinion named a problem in it" },
  "no-other-family": {
    label: "unconfirmed: the second opinion came from the first review's provider (recorded before second-opinion strength was)",
    unverified: "no second opinion of another provider confirmed it",
  },
  "second-review-failed": { label: "unconfirmed: the second opinion failed at every strength", unverified: "no second opinion answered" },
};

/**
 * The claims of the suite reviews that routed nothing: what each covered, its basis, the strength of
 * the second opinion that answered (or none, and why), how its judges stood to the check work, every strength passed over before it, its
 * findings, and each covered item it leaves unverified with the reason.
 */
export function formatSuiteReviewClaims(claims: readonly StoredClaim[]): string {
  if (claims.length === 0) return "Suite review claims: none recorded";
  const lines = [`Suite review claims (${claims.length}):`];
  for (const claim of claims) {
    const second =
      claim.second.kind === "failed"
        ? `second opinion: none (first ${claim.firstModel}): ${claim.second.reason}`
        : `second opinion: ${claim.second.strength}, ${STRENGTH_TEXT[claim.second.strength]} (first ${claim.firstModel}, second ${claim.second.model})`;
    const basis = CLAIM_BASIS[claim.basis];
    lines.push(
      `  review ${claim.reviewTaskId}, covering check task(s) ${claim.covered.join(", ")}: ${claim.basis} (${basis.label}); ${second}`,
      tiersLine(claim.tiers, { first: claim.firstModel, second: claim.second.kind === "answered" ? { model: claim.second.model, strength: claim.second.strength } : null }),
      ...claim.passedOver.map((over) => `    passed over ${over.strength} (${over.outcome}): ${over.reason}`),
      ...(claim.second.kind === "answered" ? claim.second.findings.map((finding) => `    second review: ${findingLine(finding)}`) : []),
    );
    if (claim.unverified.length === 0) lines.push("    unverified: none");
    const why = claim.second.kind === "failed" ? `${basis.unverified}: ${claim.second.reason}` : `${basis.unverified} (${STRENGTH_TEXT[claim.second.strength]})`;
    for (const item of claim.unverified) lines.push(`    unverified ${item.itemId} of task ${item.checkTaskId} "${item.itemText}": ${why}`);
  }
  return lines.join("\n");
}

/**
 * Each reviewer model's record at each kind of verdict, read from reviewer_outcomes only: how many of
 * its verdicts later evidence contradicted (a pass a witness failed) or bore out or refuted (a
 * finding), and what that model's calls at the verdict's site cost. No line means no later evidence
 * touched that reviewer's verdicts, never that every one of them held.
 */
export function formatReviewerRecord(lines: readonly ReviewerRecordLine[]): string {
  if (lines.length === 0) return "Reviewer record: no later evidence recorded against any reviewer's verdict";
  const out = [`Reviewer record (${lines.length}):`];
  for (const line of lines) {
    const unmeasured = line.cost.calls - line.cost.measuredCalls;
    out.push(
      `  ${line.reviewerModel} at ${line.site} (${line.verdictKind}): ${line.passesContradicted} pass(es) contradicted, ` +
        `${line.findingsWitnessed} finding(s) witnessed, ${line.findingsRefuted} finding(s) refuted, over ${line.evidence} piece(s) of evidence; ` +
        `${line.cost.calls} call(s) at ${line.site}, cost measured on ${line.cost.measuredCalls}: ${usd(line.cost.measuredUsd)}` +
        `${unmeasured > 0 ? `; ${unmeasured} unmeasured` : ""}`,
    );
  }
  return out.join("\n");
}

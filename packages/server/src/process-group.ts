import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Process-group termination (findings e + f, E2E Run 11)
//
// The agent-runner is spawned as an `npx -> tsx -> node` wrapper chain, and the
// smoke gate boots the target app as its own child. A plain `proc.kill()`
// signals ONLY the immediate child (npx), orphaning the tsx/node descendant
// (and, for smoke, the booted app). Run 11: a "stop" missed the tsx/node child,
// which kept dispatching and spending for ~14 minutes.
//
// The fix requires the child to be spawned with `detached: true` so it leads a
// new process group; then `process.kill(-pid, signal)` targets the WHOLE group.
// This helper signals the group, escalates SIGTERM -> SIGKILL, and AWAITS the
// child's exit so a caller can prove the tree is reaped (Discipline B).
// ---------------------------------------------------------------------------

export interface TerminateOptions {
  /** Grace period after SIGTERM before escalating to SIGKILL (ms). */
  readonly graceMs?: number;
  /** Time to wait for exit after SIGKILL before giving up (ms). */
  readonly killMs?: number;
}

export async function terminateProcessTree(
  proc: ChildProcess,
  opts: TerminateOptions = {},
): Promise<void> {
  const graceMs = opts.graceMs ?? 5000;
  const killMs = opts.killMs ?? 2000;
  const pid = proc.pid;
  if (pid === undefined) return;
  if (hasExited(proc)) return;

  const exited = onceExit(proc);
  signalGroup(proc, pid, "SIGTERM");
  await Promise.race([exited, delay(graceMs)]);
  if (hasExited(proc)) return;

  signalGroup(proc, pid, "SIGKILL");
  await Promise.race([exited, delay(killMs)]);
}

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function onceExit(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (hasExited(proc)) {
      resolve();
      return;
    }
    proc.once("exit", () => resolve());
  });
}

function signalGroup(proc: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    // Negative pid targets the whole process group led by `pid` — this is what
    // reaps the npx/tsx/node chain (requires the child spawned detached:true).
    process.kill(-pid, signal);
  } catch (e: unknown) {
    if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) {
      console.warn(`[signalGroup] Failed to signal process group ${pid}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Group already gone, or the child was not detached — fall back to the
    // immediate child so termination is still best-effort rather than silent.
    try {
      proc.kill(signal);
    } catch (e2: unknown) {
      if (!(e2 instanceof Error && 'code' in e2 && e2.code === 'ESRCH')) {
        console.warn(`[signalGroup] Failed to signal process ${pid} directly: ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

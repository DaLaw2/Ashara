import { expectedCpuMax, type CellResourceLimits } from "./cell-limits.js";
import type { Cell, ExecResult } from "./podman.js";

/*
 * Probes run from inside a real cell (roadmap M2 exit 6, ADR-074 d82 W9). Each one returns what the
 * cell itself printed and whether the protection held; none throws on a breach, so an operator run
 * records every verdict. A probe whose in-cell command could not run did not observe the
 * protection, so it does not hold (fail closed).
 */

export interface ProbeVerdict {
  readonly probe: string;
  /** True only when the cell's own output shows the protection in place. */
  readonly held: boolean;
  readonly evidence: string;
}

const PROBE_TIMEOUT_SECONDS = 30;

/** Shell builtins only, so any image with a POSIX sh can be probed. */
async function inCell(cell: Cell, script: string, args: readonly string[] = []): Promise<ExecResult> {
  return cell.exec(["sh", "-c", script, "ashara-probe", ...args], { timeoutSeconds: PROBE_TIMEOUT_SECONDS });
}

function unobserved(probe: string, result: ExecResult): ProbeVerdict {
  return {
    probe,
    held: false,
    evidence: `the probe did not run to its end (exit ${result.exitCode ?? "none"}, timed out ${result.timedOut}): ${result.stderr.trim() || "(no stderr)"}`,
  };
}

const CGROUP_SCRIPT = [
  "for f in memory.max memory.swap.max cpu.max pids.max; do",
  '  if IFS= read -r l < "/sys/fs/cgroup/$f"; then printf \'%s=%s\\n\' "$f" "$l"; else printf \'%s=unreadable\\n\' "$f"; fi',
  "done",
].join("\n");

/** The cell's own cgroup (v2) shows the configured memory, swap, CPU and pids caps. */
export async function probeResourceCaps(cell: Cell, limits: CellResourceLimits): Promise<ProbeVerdict> {
  const probe = "resource caps";
  const result = await inCell(cell, CGROUP_SCRIPT);
  if (result.exitCode !== 0) return unobserved(probe, result);
  const seen = new Map(
    result.stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line): [string, string] => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  const expected: ReadonlyArray<readonly [string, string]> = [
    ["memory.max", String(limits.memoryBytes)],
    ["memory.swap.max", "0"],
    ["cpu.max", expectedCpuMax(limits)],
    ["pids.max", String(limits.pids)],
  ];
  const mismatches = expected.filter(([file, value]) => seen.get(file) !== value);
  return {
    probe,
    held: mismatches.length === 0,
    evidence:
      expected.map(([file]) => `${file}=${seen.get(file) ?? "(not printed)"}`).join(", ") +
      (mismatches.length === 0 ? "" : `; expected ${mismatches.map(([file, value]) => `${file}=${value}`).join(", ")}`),
  };
}

/**
 * What an Ashara credential would look like if the cell could read it: a file of Z0's at its host
 * path, and values Z0 holds (DATABASE_URL, a key file's content, its own environment).
 */
export interface CredentialCanaries {
  /** Host paths that hold a credential; the cell reads each at the same path. */
  readonly paths: readonly string[];
  /** Values that must not appear in anything the cell reads, each with the name it is reported by. */
  readonly values: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

const CREDENTIAL_SCRIPT = [
  'for p in "$@"; do',
  '  if [ -f "$p" ] && [ -r "$p" ]; then',
  '    printf \'path %s readable\\n\' "$p"',
  '    while IFS= read -r l || [ -n "$l" ]; do printf \'%s\\n\' "$l"; done < "$p"',
  '  elif [ -e "$p" ]; then printf \'path %s present\\n\' "$p"',
  '  else printf \'path %s absent\\n\' "$p"; fi',
  "done",
  "export -p",
  // Every process's environment as well, when the image has a cat to read the NUL-separated files.
  'if command -v cat >/dev/null 2>&1; then for e in /proc/[0-9]*/environ; do cat "$e" 2>/dev/null; echo; done; fi',
].join("\n");

/** No credential path is readable in the cell, and no credential value appears in its files or environments. */
export async function probeCredentialRead(cell: Cell, canaries: CredentialCanaries): Promise<ProbeVerdict> {
  const probe = "credential read";
  const result = await inCell(cell, CREDENTIAL_SCRIPT, canaries.paths);
  if (result.exitCode !== 0) return unobserved(probe, result);
  // The script's own report lines name the probed paths, which a value may contain: they are not searched.
  const headers = new Set(canaries.paths.flatMap((path) => ["readable", "present", "absent"].map((state) => `path ${path} ${state}`)));
  const lines = result.stdout.split("\n");
  const pathLines = lines.filter((line) => headers.has(line));
  const readable = pathLines.filter((line) => line.endsWith(" readable"));
  const searched = lines.filter((line) => !headers.has(line)).join("\n");
  const leaked = canaries.values.filter(({ value }) => value !== "" && searched.includes(value)).map(({ name }) => name);
  const held = !result.stdoutTruncated && leaked.length === 0 && pathLines.length === canaries.paths.length;
  return {
    probe,
    held,
    evidence:
      `${pathLines.join("; ") || "no path probed"}; ${canaries.values.length} value(s) searched in the cell's output, ` +
      (leaked.length === 0 ? "none found" : `found: ${leaked.join(", ")}`) +
      (readable.length > 0 ? `; ${readable.length} path(s) readable at their host path (their content is not a credential unless a value matched)` : "") +
      (result.stdoutTruncated ? "; the output was truncated, so the search is incomplete" : ""),
  };
}

const OUTBOUND_SCRIPT = [
  'host=$1; ifs=""',
  'for d in /sys/class/net/*; do [ -e "$d" ] && ifs="$ifs ${d##*/}"; done',
  'printf \'interfaces:%s\\n\' "$ifs"',
  "n=0",
  'if [ -r /proc/net/route ]; then while read -r iface rest; do [ "$iface" = Iface ] || n=$((n + 1)); done < /proc/net/route; printf \'routes: %s\\n\' "$n"; else echo "routes: unreadable"; fi',
  'if command -v wget >/dev/null 2>&1; then wget -q -T 5 -O /dev/null "http://$host/" 2>&1; printf \'connect: wget exit %s\\n\' "$?"',
  'elif command -v curl >/dev/null 2>&1; then curl -s -m 5 -o /dev/null "http://$host/" 2>&1; printf \'connect: curl exit %s\\n\' "$?"',
  'else echo "connect: no client in the image"; fi',
].join("\n");

/**
 * The cell has no interface but loopback and no route, and a client in the image, if any, cannot
 * reach `host`.
 */
export async function probeOutboundHost(cell: Cell, host: string): Promise<ProbeVerdict> {
  const probe = "outbound host";
  const result = await inCell(cell, OUTBOUND_SCRIPT, [host]);
  if (result.exitCode !== 0) return unobserved(probe, result);
  const line = (prefix: string): string | null => result.stdout.split("\n").find((entry) => entry.startsWith(prefix)) ?? null;
  const interfaces = (line("interfaces:")?.slice("interfaces:".length).trim() ?? "").split(" ").filter((name) => name !== "");
  const routes = line("routes: ");
  const connect = line("connect: ");
  // An empty list is no observation (/sys/class/net unreadable, or the line never printed), and
  // every cell has at least lo: an empty list never shows the protection in place.
  const onlyLoopback = interfaces.length > 0 && interfaces.every((name) => name === "lo");
  const noRoute = routes === "routes: 0";
  const refused = connect !== null && (connect === "connect: no client in the image" || !/ exit 0$/.test(connect));
  return {
    probe,
    held: onlyLoopback && noRoute && refused,
    evidence: `interfaces [${interfaces.join(", ")}]; ${routes ?? "routes: (not printed)"}; ${connect ?? "connect: (not printed)"} (host ${host})`,
  };
}

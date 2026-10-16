import { expectedCpuMax, type CellResourceLimits } from "./cell-limits.js";
import { InvalidCellRequest } from "./errors.js";
import type { Cell, ExecResult } from "./podman.js";

/*
 * Probes run from inside a real cell (roadmap M2 exit 6, ADR-074 d82 W9). Each one returns what the
 * cell itself printed and its outcome; none throws on a breach, so an operator run records every
 * verdict. A probe whose in-cell command could not run, or that had no way to observe the
 * protection, is `unverifiable`, never `held` (fail closed, ADR-074 d96).
 */

/**
 * `held`: the cell's own output shows the protection in place. `breached`: it shows the protection
 * missing. `unverifiable`: it shows neither, which no caller may read as held.
 */
type ProbeOutcome = "held" | "breached" | "unverifiable";

export interface ProbeVerdict {
  readonly probe: string;
  readonly outcome: ProbeOutcome;
  readonly evidence: string;
}

/** A probe run passes only when every verdict is held: a breached or an unverifiable one fails it. */
export function summarizeProbes(verdicts: readonly ProbeVerdict[]): { readonly exitCode: 0 | 1; readonly summary: string } {
  const count = (outcome: ProbeOutcome): number => verdicts.filter((verdict) => verdict.outcome === outcome).length;
  const failed = count("breached") + count("unverifiable");
  if (verdicts.length > 0 && failed === 0) return { exitCode: 0, summary: `All ${verdicts.length} probes held.` };
  return {
    exitCode: 1,
    summary: `${failed} of ${verdicts.length} probe(s) did not hold: ${count("breached")} breached, ${count("unverifiable")} unverifiable.`,
  };
}

const PROBE_TIMEOUT_SECONDS = 30;

/** Shell builtins only, so any image with a POSIX sh can be probed. */
async function inCell(cell: Cell, script: string, args: readonly string[] = [], stdin?: string): Promise<ExecResult> {
  return cell.exec(["sh", "-c", script, "ashara-probe", ...args], { timeoutSeconds: PROBE_TIMEOUT_SECONDS, stdin });
}

function unobserved(probe: string, result: ExecResult): ProbeVerdict {
  return {
    probe,
    outcome: "unverifiable",
    evidence: `the probe did not run to its end (exit ${result.exitCode ?? "none"}, timed out ${result.timedOut}): ${result.stderr.trim() || "(no stderr)"}`,
  };
}

const CGROUP_SCRIPT = [
  "for f in memory.max memory.swap.max cpu.max pids.max; do",
  '  if IFS= read -r l < "/sys/fs/cgroup/$f"; then printf \'%s=%s\\n\' "$f" "$l"; else printf \'%s=unreadable\\n\' "$f"; fi',
  "done",
].join("\n");

/**
 * The cell's own cgroup (v2) shows the configured memory, swap, CPU and pids caps. A cap read with
 * another value is breached; a cap the cell could not read shows nothing either way, so with no
 * mismatch among those read the probe is unverifiable, never breached for a cause it did not see.
 */
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
  const read = (file: string): string | null => {
    const value = seen.get(file);
    return value === undefined || value === "unreadable" ? null : value;
  };
  const unobservedCaps = expected.filter(([file]) => read(file) === null);
  const mismatches = expected.filter(([file, value]) => read(file) !== null && read(file) !== value);
  const outcome: ProbeOutcome = mismatches.length > 0 ? "breached" : unobservedCaps.length > 0 ? "unverifiable" : "held";
  return {
    probe,
    outcome,
    evidence:
      expected.map(([file]) => `${file}=${seen.get(file) ?? "(not printed)"}`).join(", ") +
      (mismatches.length === 0 ? "" : `; expected ${mismatches.map(([file, value]) => `${file}=${value}`).join(", ")}`) +
      (unobservedCaps.length === 0 ? "" : `; not observed: ${unobservedCaps.map(([file]) => file).join(", ")}`),
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

// The paths arrive on stdin, one per line, never as arguments: an exec's argv reaches the cell as
// environment variables (podman.ts ASHARA_ARG_<n>), which the /proc/*/environ read below prints
// back, so a probed path containing a canary value (npx's INIT_CWD inside `<cwd>/.env`) would be
// reported as a leak of the probe's own input.
const CREDENTIAL_SCRIPT = [
  'while IFS= read -r p || [ -n "$p" ]; do',
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
  const unsendable = canaries.paths.filter((path) => path === "" || /[\r\n]/.test(path));
  const problems = [
    ...unsendable.map((path) => `a probed path must be one non-empty line: ${JSON.stringify(path)}`),
    ...canaries.values.filter(({ value }) => value === "").map(({ name }) => `the value ${name} is empty, and an empty value can be searched for in nothing`),
    // With nothing to probe, nothing is observed: the empty set must not read as held.
    ...(canaries.paths.length === 0 && canaries.values.length === 0 ? ["no path and no value to probe"] : []),
  ];
  if (problems.length > 0) throw new InvalidCellRequest(probe, problems);
  const result = await inCell(cell, CREDENTIAL_SCRIPT, [], canaries.paths.map((path) => `${path}\n`).join(""));
  if (result.exitCode !== 0) return unobserved(probe, result);
  // The script's own report lines name the probed paths, which a value may contain: they are not searched.
  const headers = new Set(canaries.paths.flatMap((path) => ["readable", "present", "absent"].map((state) => `path ${path} ${state}`)));
  const lines = result.stdout.split("\n");
  const pathLines = lines.filter((line) => headers.has(line));
  const readable = pathLines.filter((line) => line.endsWith(" readable"));
  const searched = lines.filter((line) => !headers.has(line)).join("\n");
  const leaked = canaries.values.filter(({ value }) => searched.includes(value)).map(({ name }) => name);
  const complete = result.stdoutCut === null && pathLines.length === canaries.paths.length;
  const outcome: ProbeOutcome = leaked.length > 0 ? "breached" : complete ? "held" : "unverifiable";
  return {
    probe,
    outcome,
    evidence:
      `${pathLines.join("; ") || "no path probed"}; ${canaries.values.length} value(s) searched in the cell's output, ` +
      (leaked.length === 0 ? "none found" : `found: ${leaked.join(", ")}`) +
      (readable.length > 0 ? `; ${readable.length} path(s) readable at their host path (their content is not a credential unless a value matched)` : "") +
      (result.stdoutCut !== null ? "; the output was truncated, so the search is incomplete" : ""),
  };
}

/** The port every mechanism dials; wget and curl reach it as http://<host>:<port>/. */
const OUTBOUND_PORT = 80;
const CONNECT_TIMEOUT_SECONDS = 5;

/*
 * Every OS-level way the image may have to open a TCP connection is tried, each one present: bash's
 * /dev/tcp, nc, wget, curl, and busybox's own wget when only the busybox binary is installed.
 * Nothing about the image's language is consulted. Each attempt prints `connect: <mechanism> exit
 * <n>` and its stderr indented below; an image with none prints `connect: none`, so an image that
 * attempted nothing is never read as held.
 */
const OUTBOUND_SCRIPT = [
  'host=$1; port=$2; t=$3; ifs=""',
  'for d in /sys/class/net/*; do [ -e "$d" ] && ifs="$ifs ${d##*/}"; done',
  'printf \'interfaces:%s\\n\' "$ifs"',
  "n=0",
  'if [ -r /proc/net/route ]; then while read -r iface rest; do [ "$iface" = Iface ] || n=$((n + 1)); done < /proc/net/route; printf \'routes: %s\\n\' "$n"; else echo "routes: unreadable"; fi',
  "tried=0",
  // A connect that hangs is bounded by timeout(1) where the image has it; the exec's own timeout bounds the rest.
  'if command -v timeout >/dev/null 2>&1; then bound="timeout $t"; else bound=""; fi',
  "attempt() {",
  "  name=$1; shift; tried=$((tried + 1))",
  '  err=$("$@" 2>&1 >/dev/null </dev/null); rc=$?',
  '  printf \'connect: %s exit %s\\n\' "$name" "$rc"',
  '  [ -z "$err" ] || printf \'%s\\n\' "$err" | while IFS= read -r l; do printf \'  %s\\n\' "$l"; done',
  "}",
  'if command -v bash >/dev/null 2>&1; then attempt bash-dev-tcp $bound bash -c \'exec 3<>"/dev/tcp/$1/$2"\' ashara-probe "$host" "$port"; fi',
  'if command -v nc >/dev/null 2>&1; then attempt nc $bound nc -w "$t" "$host" "$port"; fi',
  'if command -v wget >/dev/null 2>&1; then attempt wget $bound wget -q -T "$t" -O /dev/null "http://$host:$port/"; fi',
  'if command -v curl >/dev/null 2>&1; then attempt curl curl -s -m "$t" -o /dev/null "http://$host:$port/"; fi',
  'if ! command -v wget >/dev/null 2>&1 && command -v busybox >/dev/null 2>&1; then',
  '  attempt busybox-wget $bound busybox wget -q -T "$t" -O /dev/null "http://$host:$port/"',
  "fi",
  '[ "$tried" -gt 0 ] || echo "connect: none"',
].join("\n");

const CONNECT_LINE = /^connect: (\S+) exit (\d+)$/;
const ROUTES_LINE = /^routes: (\d+)$/;

/**
 * The cell cannot open a connection to `host`: at least one mechanism in the image tried and none
 * connected, with loopback the only interface and no route as supporting evidence. An image with no
 * mechanism, or a cell whose interfaces or routes could not be read, is unverifiable.
 */
export async function probeOutboundHost(cell: Cell, host: string): Promise<ProbeVerdict> {
  const probe = "outbound host";
  const result = await inCell(cell, OUTBOUND_SCRIPT, [host, String(OUTBOUND_PORT), String(CONNECT_TIMEOUT_SECONDS)]);
  if (result.exitCode !== 0) return unobserved(probe, result);
  const lines = result.stdout.split("\n");
  const line = (prefix: string): string | null => lines.find((entry) => entry.startsWith(prefix)) ?? null;
  const interfaces = (line("interfaces:")?.slice("interfaces:".length).trim() ?? "").split(" ").filter((name) => name !== "");
  const routes = line("routes: ");
  const routeCount = routes === null ? null : (ROUTES_LINE.exec(routes)?.[1] ?? null);
  const attempts: Array<{ readonly mechanism: string; readonly exit: string; readonly stderr: string[] }> = [];
  for (const entry of lines) {
    const match = CONNECT_LINE.exec(entry);
    if (match?.[1] !== undefined && match[2] !== undefined) attempts.push({ mechanism: match[1], exit: match[2], stderr: [] });
    else if (entry.startsWith("  ")) attempts.at(-1)?.stderr.push(entry.trim());
  }
  // An empty interface list is no observation (/sys/class/net unreadable, or the line never
  // printed): every cell has at least lo.
  const outcome: ProbeOutcome = attempts.some((attempt) => attempt.exit === "0")
    ? "breached"
    : attempts.length === 0 || interfaces.length === 0 || routeCount === null
      ? "unverifiable"
      : interfaces.every((name) => name === "lo") && routeCount === "0"
        ? "held"
        : "breached";
  const connect =
    attempts.length > 0
      ? attempts
          .map((attempt) => `${attempt.mechanism} exit ${attempt.exit}${attempt.stderr.length > 0 ? ` (${attempt.stderr.join(" / ")})` : ""}`)
          .join(", ")
      : line("connect: none") !== null
        ? "no connection mechanism in the image, none attempted"
        : "(not printed)";
  return {
    probe,
    outcome,
    evidence: `interfaces [${interfaces.join(", ")}]; ${routes ?? "routes: (not printed)"}; connect: ${connect} (host ${host}, port ${OUTBOUND_PORT})`,
  };
}

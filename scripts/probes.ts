/**
 * The isolation probes, from inside real cells, for an exit run to record.
 *
 *   just probes [--image <ref>] [--host <host>]
 *
 * Starts cells exactly as the server does (same substrate, the caps from ASHARA_CELL_MEMORY,
 * ASHARA_CELL_CPUS and ASHARA_CELL_PIDS_LIMIT, which must be set) from `--image` (the environment to
 * probe; the BaseCell when absent, config/base-cell.toml) and prints one verdict per probe:
 * the cell's resource caps, a credential read, an outbound host (`--host`, 1.1.1.1 when absent) and
 * an environment-file write without the grant. Every container and directory it makes is removed.
 * Exits 0 only when every probe held: a breached or an unverifiable probe exits 1. No database, no
 * model call.
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DATABASE_URL } from "@ashara/db";
import { probeEnvironmentWrite } from "@ashara/quality";
import {
  CELL_LIMIT_VARIABLES,
  PodmanSubstrate,
  loadBaseCell,
  probeCredentialRead,
  probeOutboundHost,
  probeResourceCaps,
  readCellLimits,
  summarizeProbes,
  type CredentialCanaries,
  type ProbeVerdict,
} from "@ashara/execution-infra";
import { resolveKeyFilePath } from "@ashara/security";
import { createLogger, describeErrorChain, stdoutSink, systemClock } from "@ashara/shared";

class ProbesUsageError extends Error {
  constructor(detail: string) {
    super(`${detail}\nUsage: just probes [--image <ref>] [--host <host>]`);
    this.name = "ProbesUsageError";
  }
}

class ProbesInterrupted extends Error {
  constructor(readonly signalName: NodeJS.Signals) {
    super(`the probe run was interrupted by ${signalName}`);
    this.name = "ProbesInterrupted";
  }
}

/** Names a cell sets for itself; a host value under one of them proves nothing about a leak. */
const CELL_OWN_NAMES = new Set(["PATH", "HOME", "HOSTNAME", "TERM", "PWD", "OLDPWD", "SHLVL", "_", "LANG", "USER", "LOGNAME", "SHELL", "container"]);
/** Shorter values match by coincidence. */
const MIN_CANARY_LENGTH = 8;

function parseArgs(args: readonly string[]): { readonly image: string | null; readonly host: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if ((flag !== "--image" && flag !== "--host") || value === undefined || value.trim() === "") {
      // eslint-disable-next-line no-restricted-syntax -- policy default: message text only
      throw new ProbesUsageError(`Unexpected or empty argument: ${flag ?? ""}.`);
    }
    if (flags.has(flag)) throw new ProbesUsageError(`${flag} given twice.`);
    flags.set(flag, value.trim());
  }
  return { image: flags.get("--image") ?? null, host: flags.get("--host") ?? "1.1.1.1" };
}

/** Z0's credentials as this process holds them: the secret key file, DATABASE_URL and its whole environment. */
async function credentialCanaries(): Promise<CredentialCanaries> {
  const keyFile = resolveKeyFilePath(process.env);
  const values: Array<{ name: string; value: string }> = [
    { name: "DATABASE_URL", value: process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL },
  ];
  try {
    const key = (await readFile(keyFile, "utf8")).trim();
    if (key === "") console.log(`(the secret key file ${keyFile} is empty, so there is no content to search for)`);
    else values.push({ name: `the secret key file ${keyFile}`, value: key });
  } catch (err) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: the operator probe says the key file was not searched for; DATABASE_URL and the environment are still searched
    console.log(`(the secret key file ${keyFile} is not readable here, so its content is not searched for: ${describeErrorChain(err)})`);
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || CELL_OWN_NAMES.has(name) || value.length < MIN_CANARY_LENGTH) continue;
    values.push({ name: `Z0 environment variable ${name}`, value });
  }
  return { paths: [keyFile, join(process.cwd(), ".env")], values };
}

async function main(): Promise<void> {
  const { image: requested, host } = parseArgs(process.argv.slice(2));
  const limits = readCellLimits(process.env);
  const image = requested ?? (await loadBaseCell()).image;
  const mountRoot = await realpath(await mkdtemp(join(tmpdir(), "ashara-probes-")));
  const instance = `probes-${randomUUID()}`;
  // One trace for the probe run: its cells are found by `podman ps --filter label=ashara.trace=<it>`.
  const trace = `probes-${randomUUID()}`;
  const substrate = new PodmanSubstrate({ podmanPath: process.env["ASHARA_PODMAN_BINARY"] ?? "podman", mountRoot, limits,
    logger: { ...createLogger({ sink: stdoutSink, clock: systemClock, minLevel: "info" }), trace: () => trace },
  });
  console.log(
    `Probing image ${image}; caps from ${Object.values(CELL_LIMIT_VARIABLES).join(", ")}: ` +
      `memory ${limits.memoryBytes} bytes, ${limits.cpus} CPUs, ${limits.pids} pids`,
  );

  // An operator's interrupt ends the probe in flight: its exec is killed, and the cells are removed below.
  const interrupt = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"] as const) process.once(name, () => interrupt.abort(new ProbesInterrupted(name)));
  const { signal } = interrupt;
  const verdicts: ProbeVerdict[] = [];
  try {
    const tree = join(mountRoot, "tree");
    await mkdir(tree);
    const cell = await substrate.createCell({ image, project: "probe", task: "probe-cell", role: "worker", instance, mount: { hostPath: tree } });
    try {
      verdicts.push(await probeResourceCaps(cell, limits, signal));
      verdicts.push(await probeCredentialRead(cell, await credentialCanaries(), signal));
      verdicts.push(await probeOutboundHost(cell, host, signal));
    } finally {
      await cell.teardown();
    }
    const workRoot = join(mountRoot, "environment-write");
    await mkdir(workRoot);
    verdicts.push(await probeEnvironmentWrite({ substrate, image, instance, workRoot, signal }));
  } finally {
    await substrate.teardownAll();
    await rm(mountRoot, { recursive: true, force: true });
  }

  for (const verdict of verdicts) console.log(`[${verdict.outcome.toUpperCase()}] ${verdict.probe}: ${verdict.evidence}`);
  const { exitCode, summary } = summarizeProbes(verdicts);
  if (exitCode !== 0) {
    console.error(`\n${summary}`);
    process.exit(exitCode);
  }
  console.log(`\n${summary}`);
}

main().catch((err: unknown) => {
  console.error(`\n${describeErrorChain(err)}\n`);
  process.exit(1);
});

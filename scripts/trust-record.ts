/**
 * Renders the internal trust record of one pre-registered stage from the trust ledger: aggregates only (false-confirm
 * rate with its exact bound, recall, drafting recall, delivery per stack, the paired comparison with the baseline arm,
 * the per-tender view, the regression column and the stop rules). No per-guarantee row is ever written to the page.
 *
 *   npx tsx scripts/trust-record.ts --ledger <ledger.jsonl> --out <record.md> [--stage <id>] [--repo <checkout>]
 *
 * The ledger is --ledger, else ASHARA_TRUST_LEDGER; no default exists, so this repository never names where it lives.
 * The stage is --stage, else the stage of the last prereg row. The checkout whose commit messages and board files
 * (the state and backlog TOML files of its records directory) are scanned for run labels is --repo, else the one
 * holding this script; its main state file must exist, since an unread board would keep a used tender in the headline.
 *
 * The analysis digest of the stage's prereg row must equal `sha256:` and the hex sha256 of this file followed by
 * scripts/trust-stats.ts (`cat scripts/trust-record.ts scripts/trust-stats.ts | sha256sum`), so the metrics, bars and
 * stop rules cannot change after a stage starts. The page is written only outside every git work tree or at a path
 * that tree ignores, so it can never be committed to the published repository.
 *
 * Exit status: 0 the page is written; 1 a usage error, an invalid ledger row (named by its seq), a missing prereg
 * row, an analysis digest mismatch or an unreadable board; 2 --out lies in a git work tree that does not ignore it, or
 * that cannot be determined.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeErrorChain } from "@ashara/shared";
import { type PairRow, type PreregRow, readTrustLedger } from "./trust-ledger.js";
import {
  deliveryPerStack,
  type Fraction,
  pairedComparison,
  type Rate,
  regressionTenders,
  stopRules,
  summarizeArm,
} from "./trust-stats.js";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS_FILES = ["trust-record.ts", "trust-stats.ts"] as const;
const USAGE = "Usage: npx tsx scripts/trust-record.ts --ledger <ledger.jsonl> --out <record.md> [--stage <id>] [--repo <checkout>]";
const ARMS = ["ashara", "baseline", "qa3"] as const;

class TrustRecordRefused extends Error {
  constructor(
    readonly status: 1 | 2,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`trust-record: ${detail}`, options);
    this.name = "TrustRecordRefused";
  }
}

interface Cli {
  readonly ledger: string;
  readonly out: string;
  readonly stage: string | undefined;
  readonly repo: string | undefined;
}

function parseCli(argv: readonly string[], env: NodeJS.ProcessEnv): Cli {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !["--ledger", "--out", "--stage", "--repo"].includes(flag) || value === undefined || value === "") {
      throw new TrustRecordRefused(1, `unexpected argument ${JSON.stringify(flag)}. ${USAGE}`);
    }
    values.set(flag, value);
  }
  const ledger = values.get("--ledger") ?? env["ASHARA_TRUST_LEDGER"];
  if (ledger === undefined || ledger === "") throw new TrustRecordRefused(1, `the ledger is given by --ledger or ASHARA_TRUST_LEDGER; neither is set. ${USAGE}`);
  const out = values.get("--out");
  if (out === undefined) throw new TrustRecordRefused(1, `--out is required. ${USAGE}`);
  return { ledger, out, stage: values.get("--stage"), repo: values.get("--repo") };
}

/**
 * The environment git runs in: a caller's GIT_DIR or work tree would answer for another repository than asked, and a
 * translated message would hide the "not a git repository" answer the output check reads.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))), LC_ALL: "C", LANGUAGE: "C" };
}

function git(cwd: string, args: readonly string[]): { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly error: Error | undefined } {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv(), maxBuffer: 256 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error };
}

/** Refuses an output path a git work tree would track: the record never enters a published tree. */
function checkOutPath(out: string): void {
  const target = path.resolve(out);
  const parent = path.dirname(target);
  const top = git(parent, ["rev-parse", "--show-toplevel"]);
  if (top.error !== undefined) throw new TrustRecordRefused(2, `cannot run git to check --out ${target}: ${top.error.message}`, { cause: top.error });
  if (top.status !== 0) {
    if (/not a git repository/.test(top.stderr)) return;
    throw new TrustRecordRefused(2, `cannot tell whether --out ${target} is in a git work tree: ${top.stderr.trim()}`);
  }
  const ignored = git(parent, ["check-ignore", "-q", "--", target]);
  if (ignored.status === 0) return;
  if (ignored.status === 1) throw new TrustRecordRefused(2, `--out ${target} is inside the git work tree ${top.stdout.trim()} and not ignored there; write the record outside it or under an ignored path`);
  throw new TrustRecordRefused(2, `git check-ignore failed for --out ${target}: ${ignored.stderr.trim()}`);
}

/**
 * The digest a stage's prereg row pins: this file and the statistics module, in that order.
 * @testseam trust-record.test.ts builds fixture prereg rows that match it
 */
export async function analysisDigest(): Promise<string> {
  const hash = createHash("sha256");
  for (const name of ANALYSIS_FILES) hash.update(await readFile(path.join(SCRIPTS, name)));
  return `sha256:${hash.digest("hex")}`;
}

async function citingTexts(repo: string): Promise<readonly string[]> {
  const log = git(repo, ["log", "--format=%H%x00%B%x00"]);
  if (log.error !== undefined || log.status !== 0) {
    throw new TrustRecordRefused(1, `cannot read the commit messages of ${repo}: ${log.error?.message ?? log.stderr.trim()}`, { cause: log.error });
  }
  const docs = path.join(repo, "docs");
  let names: readonly string[];
  try {
    names = await readdir(docs);
  } catch (err) {
    throw new TrustRecordRefused(1, `cannot read the board in ${docs} (run from the main checkout or pass --repo): ${describeErrorChain(err)}`, { cause: err });
  }
  if (!names.includes("state.toml")) throw new TrustRecordRefused(1, `${docs} holds no state.toml: the board cannot be scanned for run labels`);
  const board = names.filter((name) => /^state.*\.toml$/.test(name) || name === "backlog.toml").sort();
  const texts = [log.stdout];
  for (const name of board) {
    try {
      texts.push(await readFile(path.join(docs, name), "utf8"));
    } catch (err) {
      throw new TrustRecordRefused(1, `cannot read board file ${path.join(docs, name)}: ${describeErrorChain(err)}`, { cause: err });
    }
  }
  return texts;
}

function repoOf(argument: string | undefined): string {
  if (argument !== undefined) return path.resolve(argument);
  const top = git(SCRIPTS, ["rev-parse", "--show-toplevel"]);
  if (top.error !== undefined || top.status !== 0) throw new TrustRecordRefused(1, `cannot find the checkout holding ${SCRIPTS}; pass --repo: ${top.error?.message ?? top.stderr.trim()}`);
  return top.stdout.trim();
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "no trials" : `${((100 * part) / whole).toFixed(1)}%`;
}

function rateText(value: Rate): string {
  return `${value.events} of ${value.trials} (${percent(value.events, value.trials)}), one-sided 95% upper bound ${value.upper.toFixed(3)}`;
}

function fractionText(value: Fraction): string {
  return `${value.part} of ${value.whole} (${percent(value.part, value.whole)})`;
}

function armSection(title: string, arm: (typeof ARMS)[number], pairs: readonly PairRow[]): string[] {
  const summary = summarizeArm(arm, pairs);
  const lines = [
    `### ${title}: ${arm}`,
    "",
    `- M1 false-confirm rate: ${rateText(summary.falseConfirm)}; tenders with a false confirm: ${summary.tendersWithFalseConfirm}; pairs outside its denominator (hidden unjudged, not adequacy-gated or suite defect): ${summary.unjudgedForFalseConfirm}`,
    `- M2 confirm recall: ${fractionText(summary.recall.all)}; other than stored data ${fractionText(summary.recall.nonStored)}; stored data ${fractionText(summary.recall.stored)}`,
    `- M2 confirms by evidence class: ${[...summary.confirmsByEvidence].map(([name, count]) => `${name} ${count}`).join(", ") || "none"}`,
    `- M3 drafting recall (pairs with a first draft): ${fractionText(summary.drafting.covered)}; narrowed ${summary.drafting.narrowed}`,
    `- Reader agreement: ${fractionText(summary.readerAgreement)}`,
    `- Custody tier: ${[...summary.custody].map(([label, count]) => `${label} ${count}`).join(", ") || "no rows"}`,
    "",
    "| Cell | Pairs |",
    "|---|---|",
    ...summary.cells.map((entry) => `| ${entry.cell} | ${entry.pairs} |`),
    "",
    "| Stack | M1 |",
    "|---|---|",
    ...[...summary.perStack].map(([stack, value]) => `| ${stack} | ${rateText(value)} |`),
    "",
    "| Tender kind | M1 |",
    "|---|---|",
    ...[...summary.perKind].map(([kind, value]) => `| ${kind} | ${rateText(value)} |`),
    "",
    "| Tender | Pairs | False confirms |",
    "|---|---|---|",
    ...[...summary.perTender].map(([tender, value]) => `| ${tender} | ${value.pairs} | ${value.falseConfirms} |`),
    "",
  ];
  return lines;
}

/** The page for one stage: aggregates only. */
function renderRecord(prereg: PreregRow, stagePairs: readonly PairRow[], regression: ReadonlySet<string>): string {
  const counted = stagePairs.filter((pair) => pair.runOutcome !== "sprint0-failed");
  const headline = counted.filter((pair) => !regression.has(pair.tender));
  const regressed = counted.filter((pair) => regression.has(pair.tender));
  const arms = ARMS.filter((arm) => stagePairs.some((pair) => pair.arm === arm));
  const paired = pairedComparison(headline);
  const stops = stopRules(stagePairs, headline, paired);
  const firstStop = stops.find((stop) => stop.status === "triggered");
  const lines = [
    `# Trust record, stage ${prereg.stage}`,
    "",
    `Commit ${prereg.commit}; prereg ${prereg.preregDigest}; analysis ${prereg.analysisDigest}.`,
    "Unit: one run x intended guarantee, intention-to-treat. A Sprint 0 failure counts in delivery only.",
    "Claim: single-Epic (no row records a cumulative-guarantee run).",
    `Bars: ${prereg.bars === null ? "bars not set" : prereg.bars.join("; ")}`,
    `Regression column: ${[...regression].sort().join(", ") || "none"}`,
    "",
    "## Stop rules",
    "",
    `First triggered: ${firstStop === undefined ? "none" : firstStop.rule}`,
    "",
    ...stops.map((stop) => `- ${stop.rule}: ${stop.status}. ${stop.detail}${stop.seqs.length > 0 ? ` (ledger seq ${stop.seqs.join(", ")})` : ""}`),
    "",
    "## Paired comparison (headline)",
    "",
    paired.kind === "evaluable"
      ? `- ${paired.pairs} paired guarantee(s), ${paired.unpaired} unpaired; discordant false confirms: Ashara only ${paired.asharaOnly}, baseline only ${paired.baselineOnly}; exact one-sided McNemar p ${paired.p.toFixed(4)}`
      : `- not evaluable: ${paired.reason}`,
    "",
    "## Headline",
    "",
    ...arms.flatMap((arm) => armSection("Headline", arm, headline)),
    "## Regression column",
    "",
    ...(regressed.length === 0 ? ["No pairs.", ""] : arms.flatMap((arm) => armSection("Regression", arm, regressed))),
    "## M4 delivery per stack (every run of the stage)",
    "",
    "| Arm | Stack | Runs | Terminal | Sprint 0 failed | No report |",
    "|---|---|---|---|---|---|",
    ...arms.flatMap((arm) => [...deliveryPerStack(arm, stagePairs)].map(([stack, value]) => `| ${arm} | ${stack} | ${value.runs} | ${value.terminal} | ${value.sprint0Failed} | ${value.noReport} |`)),
    "",
  ];
  return lines.join("\n");
}

/** @testseam trust-record.test.ts runs the command in process and reads its exit status */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const cli = parseCli(argv, env);
    checkOutPath(cli.out);
    const ledger = await readTrustLedger(cli.ledger);
    const prereg = cli.stage === undefined ? ledger.prereg.at(-1) : ledger.prereg.find((row) => row.stage === cli.stage);
    if (prereg === undefined) throw new TrustRecordRefused(1, cli.stage === undefined ? "the ledger holds no prereg row" : `the ledger holds no prereg row for stage ${cli.stage}`);
    const digest = await analysisDigest();
    if (prereg.analysisDigest !== digest) {
      throw new TrustRecordRefused(1, `stage ${prereg.stage} pre-registered analysis ${prereg.analysisDigest}, but scripts/trust-record.ts and scripts/trust-stats.ts digest to ${digest}`);
    }
    const stagePairs = ledger.pairs.filter((pair) => pair.stage === prereg.stage);
    const regression = regressionTenders(stagePairs, prereg.regressionTenders, await citingTexts(repoOf(cli.repo)));
    await writeFile(path.resolve(cli.out), renderRecord(prereg, stagePairs, regression));
    console.log(`trust-record: stage ${prereg.stage} written to ${path.resolve(cli.out)}`);
    return 0;
  } catch (err) {
    console.error(describeErrorChain(err));
    return err instanceof TrustRecordRefused ? err.status : 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (status) => {
      process.exitCode = status;
    },
    (err: unknown) => {
      console.error(describeErrorChain(err));
      process.exitCode = 1;
    },
  );
}

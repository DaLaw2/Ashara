/**
 * Runs a hidden acceptance suite against a delivered product in the product's environment image, and judges each of
 * the suite's guarantees pass, fail or unjudged. An operator tool: nothing in Ashara's runtime calls it, and the
 * suite's location is given on the command line only.
 *
 *   npx tsx scripts/hidden-suite.ts --suite <suite dir> --product <product dir> --image <image> --out <verdict.json>
 *     --timeout <seconds> [--instance <label>] -- <suite arguments>
 *
 * The suite directory holds an executable `run` and a GUARANTEES.toml naming the tender and every guarantee id. The
 * suite and the product (its `.git` left out) are copied to a fresh staging directory, and one cell runs there with
 * no network and the ASHARA_CELL_* caps, in the given image: it builds the product with the `build` command of the
 * product's own environment definition, then runs `run <suite arguments> --out <file>`; `{product}` in a suite
 * argument names the product's directory in the cell. Each of the two runs is bounded by --timeout.
 *
 * The suite's verdict file is parsed and judged here, never trusted as written. The run is complete only when the
 * build and the suite both exited 0 within their bound, the verdict file is valid for the suite's tender, it does not
 * say it is incomplete, and the suite's own files are unchanged afterwards. A guarantee reads pass only in a complete
 * run whose verdict reports it passed with no failed case; one the verdict does not report, or reports twice, is
 * unjudged; in an incomplete run a reported pass is unjudged and a reported fail stays fail. Overall is incomplete
 * for an incomplete run; otherwise fail when any guarantee fails, pass when every one passes, and incomplete when
 * some are unjudged. The judged verdict is printed and written to
 * --out. Exit status: 0 pass, 1 fail, 3 incomplete, 2 a usage or runner error (then no verdict is written).
 */

import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { PodmanSubstrate, WORKSPACE_ROOT, type Cell, type ExecResult } from "@ashara/execution-infra";
import { parseEnvironmentDefinition } from "@ashara/quality";
import { JsonParseFailed, describeErrorChain, parseJson } from "@ashara/shared";

const USAGE =
  "Usage: npx tsx scripts/hidden-suite.ts --suite <suite dir> --product <product dir> --image <image> --out <verdict.json>\n" +
  "         --timeout <seconds> [--instance <label>] -- <suite arguments; {product} names the product in the cell>";

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_ERROR = 2;
const EXIT_INCOMPLETE = 3;

/** In the staging directory, which the cell sees at WORKSPACE_ROOT. */
const PRODUCT_DIR = "product";
const SUITE_DIR = "suite";
const OUT_DIR = "out";
const SUITE_VERDICT_FILE = "verdict.json";
const PRODUCT_PLACEHOLDER = "{product}";
/** How much of a run's output the stored verdict keeps, from its end. */
const OUTPUT_TAIL_CHARS = 4000;

class HiddenSuiteUsageError extends Error {
  constructor(detail: string) {
    super(`${detail}\n${USAGE}`);
    this.name = "HiddenSuiteUsageError";
  }
}

class HiddenSuiteInputInvalid extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`hidden-suite: ${JSON.stringify(path)} cannot be used: ${detail}`, options);
    this.name = "HiddenSuiteInputInvalid";
  }
}

interface RunnerArgs {
  readonly suite: string;
  readonly product: string;
  readonly image: string;
  readonly out: string;
  readonly timeoutSeconds: number;
  /** Policy default: a fresh label for this run's cell. */
  readonly instance: string;
  readonly suiteArgs: readonly string[];
}

function parseArgs(argv: readonly string[]): RunnerArgs {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const suiteArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const flags = new Map<string, string>();
  for (let i = 0; i < own.length; i += 2) {
    const flag = own[i];
    const value = own[i + 1];
    if (flag === undefined || !["--suite", "--product", "--image", "--out", "--timeout", "--instance"].includes(flag)) {
      throw new HiddenSuiteUsageError(`Unknown argument ${JSON.stringify(flag)}.`);
    }
    if (value === undefined || value === "") throw new HiddenSuiteUsageError(`${flag} needs a value.`);
    if (flags.has(flag)) throw new HiddenSuiteUsageError(`${flag} is given twice.`);
    flags.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = flags.get(flag);
    if (value === undefined) throw new HiddenSuiteUsageError(`${flag} is required.`);
    return value;
  };
  const timeout = required("--timeout");
  if (!/^[1-9][0-9]{0,5}$/.test(timeout)) throw new HiddenSuiteUsageError(`--timeout must be a positive whole number of seconds, got ${JSON.stringify(timeout)}.`);
  if (suiteArgs.length === 0) throw new HiddenSuiteUsageError("The suite's arguments follow --; none were given.");
  return {
    suite: resolve(required("--suite")),
    product: resolve(required("--product")),
    image: required("--image"),
    out: resolve(required("--out")),
    timeoutSeconds: Number(timeout),
    instance: flags.get("--instance") ?? `hidden-suite-${randomUUID()}`,
    suiteArgs,
  };
}

// --- The suite's manifest and its verdict file ------------------------------------------------------------------

const guaranteeIdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/, "a guarantee id is letters, digits, '.', '_' or '-'");

const manifestSchema = z.object({
  tender: z.string().min(1),
  guarantee: z
    .array(z.object({ id: guaranteeIdSchema }))
    .min(1, "the manifest names no guarantee")
    .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, "guarantee ids must be unique"),
});

interface SuiteManifest {
  readonly tender: string;
  readonly ids: readonly string[];
}

const verdictValueSchema = z.enum(["pass", "fail", "unjudged"]);
type GuaranteeVerdictValue = z.infer<typeof verdictValueSchema>;

const evidenceSchema = z.object({ case: z.string(), observed: z.string() });
type Evidence = z.infer<typeof evidenceSchema>;

const suiteVerdictSchema = z.object({
  tender: z.string().min(1),
  guarantees: z.array(
    z.object({
      id: guaranteeIdSchema,
      verdict: verdictValueSchema,
      cases: z.number().int().nonnegative().optional(),
      failed: z.number().int().nonnegative().optional(),
      reason: z.string().optional(),
      evidence: z.array(evidenceSchema).optional(),
    }),
  ),
  overall: z.enum(["pass", "fail", "incomplete"]).optional(),
  complete: z.boolean().optional(),
});
type SuiteVerdict = z.infer<typeof suiteVerdictSchema>;

async function readManifest(suiteDir: string): Promise<SuiteManifest> {
  const path = join(suiteDir, "GUARANTEES.toml");
  let raw: unknown;
  try {
    raw = parseToml(await readFile(path, "utf8"));
  } catch (err) {
    throw new HiddenSuiteInputInvalid(path, `it cannot be read as TOML: ${describeErrorChain(err)}`, { cause: err });
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new HiddenSuiteInputInvalid(path, parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "));
  return { tender: parsed.data.tender, ids: parsed.data.guarantee.map((entry) => entry.id) };
}

// --- Judging ----------------------------------------------------------------------------------------------------

interface JudgedGuarantee {
  readonly id: string;
  readonly verdict: GuaranteeVerdictValue;
  readonly cases?: number;
  readonly failed?: number;
  /** Set when the verdict is unjudged. */
  readonly reason?: string;
  /** The cases the suite reported, when it reported any. */
  readonly evidence?: readonly Evidence[];
}

type Overall = "pass" | "fail" | "incomplete";

/** What came back from the cell: the problems that make the run incomplete, and the verdict file if it parsed. */
interface SuiteOutcome {
  readonly problems: readonly string[];
  readonly verdict: SuiteVerdict | null;
}

function judge(manifest: SuiteManifest, outcome: SuiteOutcome): { guarantees: JudgedGuarantee[]; overall: Overall; problems: string[] } {
  const problems = [...outcome.problems];
  const verdict = outcome.verdict;
  if (verdict !== null) {
    if (verdict.tender !== manifest.tender) problems.push(`the verdict file names tender ${JSON.stringify(verdict.tender)}, the manifest ${JSON.stringify(manifest.tender)}`);
    if (verdict.complete === false) problems.push("the verdict file says the suite did not complete");
    if (verdict.overall === "incomplete") problems.push("the verdict file's overall is incomplete");
    const unknown = verdict.guarantees.map((entry) => entry.id).filter((id) => !manifest.ids.includes(id));
    if (unknown.length > 0) problems.push(`the verdict file reports guarantees the manifest does not name: ${unknown.join(", ")}`);
  }
  const complete = problems.length === 0;
  const guarantees = manifest.ids.map((id): JudgedGuarantee => {
    if (verdict === null) return { id, verdict: "unjudged", reason: `no valid verdict file: ${problems.join("; ")}` };
    const reported = verdict.guarantees.filter((entry) => entry.id === id);
    const [entry] = reported;
    if (entry === undefined) return { id, verdict: "unjudged", reason: "the verdict file does not report this guarantee" };
    const counts = { ...(entry.cases === undefined ? {} : { cases: entry.cases }), ...(entry.failed === undefined ? {} : { failed: entry.failed }) };
    const evidence = entry.evidence === undefined ? {} : { evidence: entry.evidence };
    if (reported.length > 1) return { id, verdict: "unjudged", reason: `the verdict file reports this guarantee ${reported.length} times` };
    if (entry.verdict === "fail") return { id, verdict: "fail", ...counts, ...evidence };
    if (entry.verdict === "unjudged") {
      return { id, verdict: "unjudged", ...counts, reason: entry.reason ?? "the suite gave no reason", ...evidence };
    }
    if (entry.failed !== undefined && entry.failed > 0) {
      return { id, verdict: "unjudged", ...counts, reason: `reported pass with ${entry.failed} failed case(s)`, ...evidence };
    }
    if (!complete) return { id, verdict: "unjudged", ...counts, reason: `reported pass, but the run is incomplete: ${problems.join("; ")}`, ...evidence };
    return { id, verdict: "pass", ...counts, ...evidence };
  });
  const overall: Overall = guarantees.some((entry) => entry.verdict === "fail")
    ? complete
      ? "fail"
      : "incomplete"
    : complete && guarantees.every((entry) => entry.verdict === "pass")
      ? "pass"
      : "incomplete";
  return { guarantees, overall, problems };
}

// --- Staging and the cell ---------------------------------------------------------------------------------------

/** A digest of a directory tree: every entry's path, kind, executable bit and content, in sorted order. */
async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(relative: string): Promise<void> {
    const names = (await readdir(join(root, relative))).sort();
    for (const name of names) {
      const path = relative === "" ? name : `${relative}/${name}`;
      const full = join(root, path);
      const entry = await lstat(full);
      if (entry.isSymbolicLink()) {
        hash.update(`l\0${path}\0${await readlink(full)}\0`);
      } else if (entry.isDirectory()) {
        hash.update(`d\0${path}\0`);
        await walk(path);
      } else if (entry.isFile()) {
        hash.update(`f\0${path}\0${(entry.mode & 0o111) === 0 ? "-" : "x"}\0`);
        hash.update(await readFile(full));
        hash.update("\0");
      } else {
        hash.update(`o\0${path}\0`);
      }
    }
  }
  await walk("");
  return `sha256:${hash.digest("hex")}`;
}

async function requireDirectory(path: string, what: string): Promise<void> {
  try {
    if ((await lstat(path)).isDirectory()) return;
  } catch (err) {
    throw new HiddenSuiteInputInvalid(path, `the ${what} cannot be read: ${describeErrorChain(err)}`, { cause: err });
  }
  throw new HiddenSuiteInputInvalid(path, `the ${what} is not a directory`);
}

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL_CHARS ? text : `[... ${text.length - OUTPUT_TAIL_CHARS} characters cut]${text.slice(-OUTPUT_TAIL_CHARS)}`;
}

interface RunRecord {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly statusLost: boolean;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

function recordOf(result: ExecResult): RunRecord {
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    statusLost: result.statusLost,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
  };
}

/** Why a run did not end well, or null when it exited 0 within its bound. */
function runProblem(what: string, result: ExecResult, timeoutSeconds: number): string | null {
  if (result.timedOut) return `${what} did not finish within ${timeoutSeconds} s`;
  if (result.statusLost) return `${what} ended with its exit status lost`;
  if (result.exitCode !== 0) return `${what} exited ${String(result.exitCode)}`;
  return null;
}

async function readSuiteVerdict(path: string, problems: string[]): Promise<SuiteVerdict | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    problems.push(`the suite wrote no verdict file (${describeErrorChain(err)})`);
    return null;
  }
  try {
    return parseJson(suiteVerdictSchema, text, "the suite's verdict file");
  } catch (err) {
    if (!(err instanceof JsonParseFailed)) throw err;
    problems.push(`the verdict file is invalid: ${describeErrorChain(err)}`);
    return null;
  }
}

async function runInCell(args: RunnerArgs, manifest: SuiteManifest, build: string, stage: string): Promise<{ outcome: SuiteOutcome; runs: Record<string, RunRecord> }> {
  const substrate = new PodmanSubstrate({ podmanPath: "podman", mountRoot: stage, trace: () => args.instance });
  const workspace = join(stage, "ws");
  let cell: Cell | null = null;
  try {
    cell = await substrate.createCell({
      image: args.image,
      project: "hidden-suite",
      task: "suite-run",
      role: "judge",
      instance: args.instance,
      mount: { hostPath: workspace },
    });
    const runs: Record<string, RunRecord> = {};
    const built = await cell.exec(["sh", "-c", build], { timeoutSeconds: args.timeoutSeconds, cwd: PRODUCT_DIR });
    runs["build"] = recordOf(built);
    const buildProblem = runProblem(`the product's build command ${JSON.stringify(build)}`, built, args.timeoutSeconds);
    if (buildProblem !== null) return { outcome: { problems: [buildProblem], verdict: null }, runs };

    const inCellProduct = `${WORKSPACE_ROOT}/${PRODUCT_DIR}`;
    const suiteDigestBefore = await treeDigest(join(workspace, SUITE_DIR));
    const argv = [
      `${WORKSPACE_ROOT}/${SUITE_DIR}/run`,
      ...args.suiteArgs.map((arg) => arg.split(PRODUCT_PLACEHOLDER).join(inCellProduct)),
      "--out",
      `${WORKSPACE_ROOT}/${OUT_DIR}/${SUITE_VERDICT_FILE}`,
    ];
    const suite = await cell.exec(argv, { timeoutSeconds: args.timeoutSeconds, cwd: OUT_DIR });
    runs["suite"] = recordOf(suite);
    const problems: string[] = [];
    const suiteProblem = runProblem(`the suite (${manifest.tender})`, suite, args.timeoutSeconds);
    if (suiteProblem !== null) problems.push(suiteProblem);
    if ((await treeDigest(join(workspace, SUITE_DIR))) !== suiteDigestBefore) problems.push("the suite's files changed while it ran");
    const verdict = await readSuiteVerdict(join(workspace, OUT_DIR, SUITE_VERDICT_FILE), problems);
    return { outcome: { problems, verdict }, runs };
  } finally {
    // The cell first, then whatever this substrate still holds; a failure here is the run's error.
    try {
      if (cell !== null) await cell.teardown();
    } finally {
      await substrate.teardownAll();
    }
  }
}

function printVerdict(record: { tender: string; overall: Overall; guarantees: readonly JudgedGuarantee[]; problems: readonly string[] }, out: string): void {
  console.log(`hidden-suite: tender ${record.tender} overall ${record.overall}`);
  for (const entry of record.guarantees) {
    const counts = entry.cases === undefined ? "" : ` (${entry.cases} cases${entry.failed === undefined ? "" : `, ${entry.failed} failed`})`;
    const first = entry.evidence?.[0];
    const detail = entry.reason !== undefined ? `: ${entry.reason}` : first === undefined ? "" : `: ${first.case}: ${first.observed}`;
    console.log(`  ${entry.id} ${entry.verdict}${counts}${detail}`);
  }
  for (const problem of record.problems) console.log(`  incomplete because: ${problem}`);
  console.log(`verdict written to ${out}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  await requireDirectory(args.suite, "suite directory");
  await requireDirectory(args.product, "product directory");
  const manifest = await readManifest(args.suite);
  const definitionPath = join(args.product, "environment", "environment.toml");
  let definitionText: string;
  try {
    definitionText = await readFile(definitionPath, "utf8");
  } catch (err) {
    throw new HiddenSuiteInputInvalid(definitionPath, `the product's environment definition cannot be read: ${describeErrorChain(err)}`, { cause: err });
  }
  const definition = parseEnvironmentDefinition(definitionText, definitionPath);

  const stage = await realpath(await mkdtemp(join(tmpdir(), "ashara-hidden-suite-")));
  try {
    const workspace = join(stage, "ws");
    await mkdir(join(workspace, OUT_DIR), { recursive: true });
    const productGit = join(args.product, ".git");
    await cp(args.product, join(workspace, PRODUCT_DIR), { recursive: true, verbatimSymlinks: true, filter: (source) => source !== productGit });
    await cp(args.suite, join(workspace, SUITE_DIR), { recursive: true, verbatimSymlinks: true });
    const productDigest = await treeDigest(join(workspace, PRODUCT_DIR));
    const suiteDigest = await treeDigest(join(workspace, SUITE_DIR));

    const startedAt = new Date().toISOString();
    const { outcome, runs } = await runInCell(args, manifest, definition.build, stage);
    const endedAt = new Date().toISOString();
    const judged = judge(manifest, outcome);
    const record = {
      tender: manifest.tender,
      suiteDigest,
      product: { dir: args.product, digest: productDigest },
      image: args.image,
      suiteArgs: args.suiteArgs,
      timeoutSeconds: args.timeoutSeconds,
      startedAt,
      endedAt,
      overall: judged.overall,
      guarantees: judged.guarantees,
      problems: judged.problems,
      runs,
    };
    await mkdir(dirname(args.out), { recursive: true });
    const temporary = `${args.out}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    await rename(temporary, args.out);
    printVerdict(record, args.out);
    return judged.overall === "pass" ? EXIT_PASS : judged.overall === "fail" ? EXIT_FAIL : EXIT_INCOMPLETE;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

main().then(
  (status) => {
    process.exitCode = status;
  },
  (err: unknown) => {
    console.error(`\n${describeErrorChain(err)}\n`);
    process.exitCode = EXIT_ERROR;
  },
);

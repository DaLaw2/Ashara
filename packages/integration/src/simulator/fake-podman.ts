import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, sep } from "node:path";
import { z } from "zod";
import type { ProcessRunner } from "@ashara/execution-infra";
import { JsonParseFailed, parseJson } from "@ashara/shared";
import { CHECK_MISSING_EXIT } from "@ashara/workplace";
import {
  CONFLICT_MARKER_LINE,
  CheckSpecSchema,
  HUNG,
  LAYOUT_FILE,
  PUBLIC_INTERFACE_PATH,
  RECIPE_DEFECT_SYMPTOM,
  RECIPE_DEFECT_TOKEN,
  TOOLCHAIN_TOKEN,
  exited,
  isScaffoldInterface,
  recipeTokens,
} from "./product.js";
import type { SimOutcome } from "./product.js";
import type { Tape } from "./tape.js";

type ProcessRequest = Parameters<ProcessRunner>[0];
type ProcessResult = Awaited<ReturnType<ProcessRunner>>;

/** The cell's mount point of its tree: the podman contract of execution-infra's substrate. */
const WORKSPACE = "/workspace";
/** The write tool's script (cell-backend.ts): `"$1"` is the path, the content comes on stdin. */
const WRITE_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';

interface FakeMount {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly readOnly: boolean;
}

interface FakeImage {
  readonly id: string;
  readonly refs: Set<string>;
  readonly labels: Readonly<Record<string, string>>;
  readonly tokens: readonly string[];
}

/** One container as `podman run` created it: what I3 judges, from the actual run arguments. */
export interface FakeCell {
  readonly id: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly imageId: string;
  readonly tokens: readonly string[];
  readonly mounts: readonly FakeMount[];
}

/** What the fake container runtime saw, for the trace and the invariant checker. */
export type PodmanEvent =
  | { readonly kind: "cell-started"; readonly cell: FakeCell }
  | { readonly kind: "cell-removed"; readonly id: string }
  | {
      readonly kind: "image-built";
      readonly id: string;
      readonly tokens: readonly string[];
      readonly contextFiles: readonly string[];
    }
  | {
      readonly kind: "command";
      readonly cellId: string;
      readonly command: string;
      readonly exitCode: number;
      readonly hung: boolean;
    };

interface FakePodmanOptions {
  /** The BaseCell image reference (config/base-cell.toml): known to the runtime, with no recipe tokens. */
  readonly baseImage: string;
  /** Flaky checks draw from it. */
  readonly tape: Tape;
  readonly observe: (event: PodmanEvent) => void;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function result(request: ProcessRequest, outcome: SimOutcome): ProcessResult {
  if (outcome.hung) {
    return {
      exitCode: null,
      signal: "SIGKILL",
      stdout: outcome.stdout,
      stdoutCut: null,
      stderr: outcome.stderr,
      stderrCut: null,
      killedByHost: true,
      stdinError: null,
      statusReport: request.statusChannel === true ? "" : null,
    };
  }
  return {
    exitCode: outcome.exitCode,
    signal: null,
    stdout: outcome.stdout,
    stdoutCut: null,
    stderr: outcome.stderr,
    stderrCut: null,
    killedByHost: false,
    stdinError: null,
    statusReport: request.statusChannel === true ? `${outcome.exitCode}\n` : null,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return false;
    throw err;
  }
}

/** Every file under `root`, repo-relative, sorted, never descending into `.git`. */
async function listFiles(root: string, under = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, under), { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = under === "" ? entry.name : `${under}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

/** `label=<key>` (the key present, any value) or `label=<key>=<value>`, the two forms of podman's label filter. */
const LABEL_FILTER = /^label=([^=]+)(?:=(.*))?$/;

interface LabelFilter {
  readonly key: string;
  /** Null: any value of `key` matches. */
  readonly value: string | null;
}

function unsupportedFilter(raw: string): string {
  return (
    `Error: fake podman: unsupported --filter ${JSON.stringify(raw)}; only label=<key> and label=<key>=<value> ` +
    `are interpreted`
  );
}

function matchesLabel(labels: Readonly<Record<string, string>>, filter: LabelFilter): boolean {
  return Object.hasOwn(labels, filter.key) && (filter.value === null || labels[filter.key] === filter.value);
}

/**
 * A ProcessRunner that answers every podman subcommand the substrate and the environment build
 * issue, over a table of cells and images per run. Commands run in a cell are interpreted: the
 * file tools' POSIX utilities on the mounted host directory, and `sh -c` only for `sim ...`
 * commands; anything else exits 127, so an unrunnable check is really unrunnable.
 */
export class FakePodman {
  private readonly images = new Map<string, FakeImage>();
  private readonly cells = new Map<string, FakeCell>();
  private counter = 0;

  constructor(private readonly options: FakePodmanOptions) {
    const id = sha256(options.baseImage);
    this.images.set(id, { id, refs: new Set([options.baseImage]), labels: {}, tokens: [] });
  }

  readonly runner: ProcessRunner = (request) => this.handle(request);

  /** Cells still "running": a dead process's cells stay here until a reconcile removes them. */
  liveCells(): readonly FakeCell[] {
    return [...this.cells.values()];
  }

  private nextId(what: string): string {
    this.counter += 1;
    return sha256(`${what}-${this.counter}`);
  }

  private async handle(request: ProcessRequest): Promise<ProcessResult> {
    const args = request.args;
    const ok = (stdout = ""): ProcessResult => result(request, exited(0, stdout));
    const fail = (code: number, stderr: string): ProcessResult => result(request, exited(code, "", stderr));
    switch (args[0]) {
      case "info":
        return ok(JSON.stringify({ version: { Version: "5.0.0-sim" }, host: { security: { rootless: true } } }));
      case "run":
        return this.run(request);
      case "exec":
        return this.exec(request);
      case "rm": {
        /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing
           argument reads as empty and is refused as podman refuses it; no oracle reads it */
        const target = args.at(-1) ?? "";
        const cell = [...this.cells.values()].find((c) => c.id === target || c.name === target);
        if (cell !== undefined) {
          this.cells.delete(cell.id);
          this.options.observe({ kind: "cell-removed", id: cell.id });
        } else if (!args.includes("--ignore")) {
          return fail(1, `Error: no container with name or ID "${target}" found: no such container`);
        }
        return ok();
      }
      // Repeated label filters are OR-ed, as podman 4.9.3's `images` ORs them: the weakest a podman
      // gives, so a listing is a superset the code under test must select from by labels itself.
      case "ps": {
        const filters = this.labelFilters(args);
        if ("unsupported" in filters) return fail(125, unsupportedFilter(filters.unsupported));
        const rows = [...this.cells.values()]
          .filter((cell) => filters.length === 0 || filters.some((filter) => matchesLabel(cell.labels, filter)))
          .map((cell) => ({ Id: cell.id, Labels: cell.labels, ImageID: cell.imageId }));
        return ok(JSON.stringify(rows));
      }
      case "images": {
        const filters = this.labelFilters(args);
        if ("unsupported" in filters) return fail(125, unsupportedFilter(filters.unsupported));
        const rows = [...this.images.values()]
          .filter((image) => filters.length === 0 || filters.some((filter) => matchesLabel(image.labels, filter)))
          .map((image) => ({ Id: image.id, Labels: image.labels }));
        return ok(JSON.stringify(rows));
      }
      case "image": {
        /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing
           argument reads as empty and is refused as podman refuses it; no oracle reads it */
        const ref = args.at(-1) ?? "";
        const image = this.imageOf(ref);
        switch (args[1]) {
          case "exists":
            return image === null ? fail(1, "") : ok();
          case "inspect":
            return image === null
              ? fail(125, `Error: ${ref}: image not known`)
              : ok(JSON.stringify([{ Id: image.id, Labels: image.labels }]));
          case "rm": {
            if (image === null) return fail(1, `Error: ${ref}: image not known`);
            if ([...this.cells.values()].some((cell) => cell.imageId === image.id))
              return fail(2, `Error: image ${image.id} is in use by a container`);
            this.images.delete(image.id);
            return ok(`Untagged: ${[...image.refs].join(", ")}\nDeleted: ${image.id}\n`);
          }
          default:
            /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, message
               text only */
            return fail(125, `fake podman: unknown image subcommand ${args[1] ?? ""}`);
        }
      }
      case "build":
        return this.build(request);
      default:
        return fail(125, `fake podman: unknown subcommand ${args[0] ?? "(none)"}`);
    }
  }

  /** A filter it cannot interpret is refused, never dropped: a dropped filter would list every row. */
  private labelFilters(args: readonly string[]): LabelFilter[] | { readonly unsupported: string } {
    const filters: LabelFilter[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== "--filter") continue;
      /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing filter
         value is refused below as unsupported */
      const raw = args[i + 1] ?? "";
      const match = LABEL_FILTER.exec(raw);
      if (match?.[1] === undefined) return { unsupported: raw };
      filters.push({ key: match[1], value: match[2] ?? null });
    }
    return filters;
  }

  private imageOf(ref: string): FakeImage | null {
    const bare = ref.replace(/^sha256:/, "");
    return this.images.get(bare) ?? [...this.images.values()].find((image) => image.refs.has(ref)) ?? null;
  }

  private async run(request: ProcessRequest): Promise<ProcessResult> {
    const args = request.args.slice(1);
    const labels: Record<string, string> = {};
    const mounts: FakeMount[] = [];
    let name = "";
    let image: string | null = null;
    for (let i = 0; i < args.length && image === null; i++) {
      /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing
         argument reads as empty and is refused as podman refuses it; no oracle reads it */
      const arg = args[i] ?? "";
      /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing
         argument reads as empty and is refused as podman refuses it; no oracle reads it */
      const value = args[i + 1] ?? "";
      if (arg === "--name") {
        name = value;
        i++;
      } else if (arg === "--label") {
        const at = value.indexOf("=");
        labels[value.slice(0, at)] = value.slice(at + 1);
        i++;
      } else if (arg === "-e") {
        i++;
      } else if (arg === "-v") {
        const [hostPath = "", containerPath = "", options = ""] = value.split(":");
        mounts.push({ hostPath, containerPath, readOnly: options.split(",").includes("ro") });
        i++;
      } else if (!arg.startsWith("-")) {
        image = arg;
      }
    }
    const known = image === null ? null : this.imageOf(image);
    if (known === null) return result(request, exited(125, "", `Error: ${image ?? "(none)"}: image not known`));
    const cell: FakeCell = { id: this.nextId("cell"), name, labels, imageId: known.id, tokens: known.tokens, mounts };
    this.cells.set(cell.id, cell);
    this.options.observe({ kind: "cell-started", cell });
    return result(request, exited(0, `${cell.id}\n`));
  }

  private async exec(request: ProcessRequest): Promise<ProcessResult> {
    const args = request.args;
    // The standalone sweep after a host-killed exec: nothing is left running in a fake cell.
    if (args[2] === "sh" && args[4] !== undefined && args.at(-1) === "ashara-sweep")
      return result(request, exited(0, ""));
    // exec -i --preserve-fds=1 -w <workdir> (-e ASHARA_ARGC=<n> -e ASHARA_ARG_<i>=<arg>)... <cell> sh -c WRAPPER
    // ashara-exec <grace> <seconds>
    const workdirAt = args.indexOf("-w");
    const workdir = args[workdirAt + 1] ?? WORKSPACE;
    const environment = new Map<string, string>();
    let at = workdirAt + 2;
    while (args[at] === "-e") {
      /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing
         argument reads as empty and is refused as podman refuses it; no oracle reads it */
      const variable = args[at + 1] ?? "";
      const eq = variable.indexOf("=");
      environment.set(variable.slice(0, eq), variable.slice(eq + 1));
      at += 2;
    }
    /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing cell id
       names no cell; no oracle reads it */
    const cell = this.cells.get(args[at] ?? "");
    if (cell === undefined)
      return result(request, { exitCode: 125, stdout: "", stderr: "Error: no such container", hung: false });
    /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, an unset variable
       reads as empty as in a shell; no oracle reads it */
    const argc = Number(environment.get("ASHARA_ARGC") ?? "");
    if (!Number.isInteger(argc) || argc < 1)
      return result(request, { exitCode: 125, stdout: "", stderr: "ashara-exec: no argv in ASHARA_ARGC", hung: false });
    /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, an unset variable
       reads as empty as in a shell; no oracle reads it */
    const argv = Array.from({ length: argc }, (_, i) => environment.get(`ASHARA_ARG_${i}`) ?? "");
    const outcome = await this.command(cell, workdir, argv, request.stdin);
    this.options.observe({
      kind: "command",
      cellId: cell.id,
      command: argv.join(" ").slice(0, 200),
      exitCode: outcome.exitCode,
      hung: outcome.hung,
    });
    return result(request, outcome);
  }

  /** The host path of a cell path, and whether its mount is read-only; null outside every mount. */
  private hostOf(
    cell: FakeCell,
    workdir: string,
    path: string,
  ): { readonly host: string; readonly readOnly: boolean } | null {
    const absolute = posix.resolve(workdir, path);
    const mount = [...cell.mounts]
      .sort((a, b) => b.containerPath.length - a.containerPath.length)
      .find((m) => absolute === m.containerPath || absolute.startsWith(`${m.containerPath}/`));
    if (mount === undefined) return null;
    const rest = posix.relative(mount.containerPath, absolute);
    return { host: rest === "" ? mount.hostPath : join(mount.hostPath, ...rest.split("/")), readOnly: mount.readOnly };
  }

  private async command(
    cell: FakeCell,
    workdir: string,
    argv: readonly string[],
    stdin: string | Buffer | undefined,
  ): Promise<SimOutcome> {
    const [program, ...rest] = argv;
    switch (program) {
      case "cat": {
        /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing
           argument reads as empty and is refused as podman refuses it; no oracle reads it */
        const path = rest.at(-1) ?? "";
        const host = this.hostOf(cell, workdir, path);
        if (host === null || !(await exists(host.host)))
          return exited(1, "", `cat: ${path}: No such file or directory`);
        return exited(0, await readFile(host.host, "utf8"));
      }
      case "find": {
        const path = rest[1] ?? ".";
        const depth = Number(rest[rest.indexOf("-maxdepth") + 1] ?? "1");
        const host = this.hostOf(cell, workdir, path);
        if (host === null || !(await exists(host.host)))
          return exited(1, "", `find: '${path}': No such file or directory`);
        const lines: string[] = [];
        const walk = async (dir: string, shown: string, level: number): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (entry.name === ".git") continue;
            const entryShown = `${shown}/${entry.name}`;
            lines.push(entry.isDirectory() ? `${entryShown}/` : entryShown);
            if (entry.isDirectory() && level < depth) await walk(join(dir, entry.name), entryShown, level + 1);
          }
        };
        await walk(host.host, path, 1);
        return exited(0, lines.map((line) => `${line}\n`).join(""));
      }
      case "grep": {
        /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing
           argument reads as empty as in a shell; no oracle reads it */
        const pattern = rest[rest.indexOf("-e") + 1] ?? "";
        const path = rest.at(-1) ?? ".";
        const host = this.hostOf(cell, workdir, path);
        if (host === null) return exited(2, "", `grep: ${path}: No such file or directory`);
        let regex: RegExp;
        try {
          regex = new RegExp(pattern);
        } catch (err) {
          return exited(2, "", `grep: invalid pattern: ${err instanceof Error ? err.message : String(err)}`);
        }
        const matches: string[] = [];
        for (const file of await listFiles(host.host)) {
          const lines = (await readFile(join(host.host, file), "utf8")).split("\n");
          lines.forEach((line, i) => {
            if (regex.test(line)) matches.push(`${path}/${file}:${i + 1}:${line}`);
          });
        }
        return matches.length === 0 ? exited(1, "") : exited(0, matches.map((m) => `${m}\n`).join(""));
      }
      case "sh": {
        if (rest[0] !== "-c") return exited(127, "", "sh: only -c is interpreted in a fake cell");
        if (rest[1] === WRITE_SCRIPT) {
          /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing
             argument reads as empty and is refused as podman refuses it; no oracle reads it */
          const path = rest[3] ?? "";
          const host = this.hostOf(cell, workdir, path);
          if (host === null) return exited(1, "", `sh: ${path}: outside every mount`);
          if (host.readOnly) return exited(1, "", `sh: ${path}: Read-only file system`);
          await mkdir(dirname(host.host), { recursive: true });
          /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, no stdin
             writes an empty file as a shell redirect does; no oracle reads it */
          await writeFile(host.host, stdin ?? "");
          return exited(0, "");
        }
        /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing
           argument reads as empty as in a shell; no oracle reads it */
        return this.shell(cell, workdir, rest[1] ?? "");
      }
      default:
        // eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, message text only
        return exited(127, "", `sh: ${program ?? ""}: not found`);
    }
  }

  /** `sh -c <command>`: only `sim` commands exist in a fake cell. */
  private async shell(cell: FakeCell, workdir: string, command: string): Promise<SimOutcome> {
    const words = command.trim().split(/\s+/);
    // eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, message text only
    if (words[0] !== "sim") return exited(127, "", `sh: 1: ${words[0] ?? ""}: not found`);
    const root = this.hostOf(cell, workdir, ".");
    if (root === null) return exited(1, "", "sim: the working directory is outside every mount");
    const has = (path: string): Promise<boolean> => exists(join(root.host, ...path.split("/")));
    switch (words[1]) {
      case "probe":
        return cell.tokens.includes(TOOLCHAIN_TOKEN)
          ? exited(0, "sim toolchain ok\n")
          : exited(1, "", "sim: no toolchain in this image\n");
      case "build":
        if (cell.tokens.includes(RECIPE_DEFECT_TOKEN))
          return exited(1, "", `sim build: permission denied: ${RECIPE_DEFECT_SYMPTOM}\n`);
        if (!(await has(LAYOUT_FILE)))
          return exited(1, "", `sim build: ${LAYOUT_FILE} is missing: the product has no layout\n`);
        return exited(0, "sim build ok\n");
      case "test":
        if (cell.tokens.includes(RECIPE_DEFECT_TOKEN))
          return exited(1, "", `sim test: permission denied: ${RECIPE_DEFECT_SYMPTOM}\n`);
        if (!(await has(LAYOUT_FILE))) return exited(1, "", `sim test: ${LAYOUT_FILE} is missing\n`);
        return exited(0, "sim tests ok\n");
      case "rm": {
        if (root.readOnly) return exited(1, "", "sim rm: Read-only file system\n");
        /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing
           argument reads as empty as in a shell; no oracle reads it */
        await rm(join(root.host, ...(words[2] ?? "").split("/")), { force: true });
        return exited(0, "");
      }
      case "resolve": {
        // A model resolving a conflict by keeping both sides: every marker line goes, every side's line stays.
        if (root.readOnly) return exited(1, "", "sim resolve: Read-only file system\n");
        /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing
           argument reads as empty as in a shell; no oracle reads it */
        const path = words[2] ?? "";
        const file = join(root.host, ...path.split("/"));
        if (!(await exists(file))) return exited(1, "", `sim resolve: ${path}: no such file\n`);
        const lines = (await readFile(file, "utf8")).split("\n");
        await writeFile(file, lines.filter((line) => !CONFLICT_MARKER_LINE.test(line)).join("\n"));
        return exited(0, "");
      }
      case "sleep":
        return HUNG;
      case "check":
        /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing
           argument names no check file, which the check refuses; no oracle reads it */
        return this.check(root.host, root.readOnly, words[2] ?? "", has);
      default:
        // eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, message text only
        return exited(127, "", `sim: unknown command ${words[1] ?? ""}\n`);
    }
  }

  private async check(
    root: string,
    readOnly: boolean,
    specPath: string,
    has: (path: string) => Promise<boolean>,
  ): Promise<SimOutcome> {
    const file = join(root, ...specPath.split("/"));
    if (!(await exists(file))) return exited(2, "", `sim check: ${specPath}: no such check file\n`);
    let spec: z.infer<typeof CheckSpecSchema>;
    try {
      spec = parseJson(CheckSpecSchema, await readFile(file, "utf8"), `sim check file ${specPath}`);
    } catch (err) {
      if (!(err instanceof JsonParseFailed)) throw err;
      return exited(2, "", `sim check: ${err.message}\n`);
    }
    for (const harness of spec.harness) {
      if (readOnly) return exited(1, "", "sim check: Read-only file system\n");
      const target = join(root, ...harness.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, harness.content);
    }
    switch (spec.kind) {
      case "unrunnable":
        return exited(127, "", "sh: 1: sim-check-runner: not found\n");
      case "slow":
        return HUNG;
      case "vacuous":
        return exited(0, "ok\n");
      case "interface": {
        const path = join(root, ...PUBLIC_INTERFACE_PATH.split("/"));
        if (!(await exists(path)))
          return exited(CHECK_MISSING_EXIT, "", `sim check ${specPath}: ${PUBLIC_INTERFACE_PATH} is missing\n`);
        if (isScaffoldInterface(await readFile(path, "utf8"))) {
          return exited(
            CHECK_MISSING_EXIT,
            "",
            `sim check ${specPath}: ${PUBLIC_INTERFACE_PATH} is still the scaffold's\n`,
          );
        }
        return exited(0, `sim check ${specPath}: pass\n`);
      }
      default:
        break;
    }
    const missing: string[] = [];
    for (const behaviour of spec.requires) if (!(await has(`product/behaviours/${behaviour}`))) missing.push(behaviour);
    const present: string[] = [];
    for (const behaviour of spec.forbids) if (await has(`product/behaviours/${behaviour}`)) present.push(behaviour);
    // The scripted author's check states its verdict as the check-author brief asks (CHECK_MISSING_EXIT);
    // its own failures above (no such file, not JSON, unrunnable) exit otherwise. A flake is a wrong verdict.
    if (missing.length > 0 || present.length > 0) {
      return exited(
        CHECK_MISSING_EXIT,
        "",
        `sim check ${specPath}: missing [${missing.join(", ")}], forbidden present [${present.join(", ")}]\n`,
      );
    }
    if (spec.kind === "flaky" && this.options.tape.chance("podman.flaky-check", 0.3)) {
      return exited(CHECK_MISSING_EXIT, "", `sim check ${specPath}: flaked\n`);
    }
    return exited(0, `sim check ${specPath}: pass\n`);
  }

  private async build(request: ProcessRequest): Promise<ProcessResult> {
    const args = request.args;
    const labels: Record<string, string> = {};
    let iidFile = "";
    let containerfile = "";
    let tag = "";
    for (let i = 1; i < args.length - 1; i++) {
      /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing
         argument reads as empty and is refused as podman refuses it; no oracle reads it */
      const arg = args[i] ?? "";
      /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing
         argument reads as empty and is refused as podman refuses it; no oracle reads it */
      const value = args[i + 1] ?? "";
      if (arg === "--label") {
        const at = value.indexOf("=");
        labels[value.slice(0, at)] = value.slice(at + 1);
        i++;
      } else if (arg === "--iidfile") {
        iidFile = value;
        i++;
      } else if (arg === "-f") {
        containerfile = value;
        i++;
      } else if (arg === "-t") {
        tag = value;
        i++;
      }
    }
    /* eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, a missing argument
       reads as empty and is refused as podman refuses it; no oracle reads it */
    const context = args.at(-1) ?? "";
    if (!(await exists(containerfile)))
      return result(request, exited(125, "", `Error: ${containerfile}: no such file\n`));
    const text = await readFile(containerfile, "utf8");
    if (!/^FROM\s+\S+/m.test(text))
      return result(request, exited(125, "", "Error: the containerfile has no FROM instruction\n"));
    const files = await listFiles(context);
    const contents = await Promise.all(
      files.map(async (file) => `${file}\0${await readFile(join(context, file), "utf8")}`),
    );
    const id = sha256(contents.join("\0\0"));
    const tokens = recipeTokens(text);
    const existing = this.images.get(id);
    if (existing !== undefined) existing.refs.add(tag);
    else this.images.set(id, { id, refs: new Set([tag]), labels, tokens });
    await writeFile(iidFile, `sha256:${id}`);
    this.options.observe({ kind: "image-built", id, tokens, contextFiles: files.map((f) => f.split(sep).join("/")) });
    // eslint-disable-next-line no-restricted-syntax -- policy default: fake-podman test plumbing, build log text only
    return result(request, exited(0, `STEP 1/1: ${text.split("\n")[0] ?? ""}\nCOMMIT ${tag}\n${id}\n`));
  }
}

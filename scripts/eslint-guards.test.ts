import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, test } from "vitest";

const REPO = join(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: REPO });
const PRODUCTION_FILE = join(REPO, "packages", "shared", "src", "planted.ts");
const TEST_FILE = join(REPO, "packages", "shared", "src", "planted.test.ts");

const SWALLOWED = "Swallowed promise rejection";
const IDENTITY = "Identity-element fallback";
const JSON_PARSE = "JSON.parse outside parseJson";
const BARE_ERROR = "Bare Error";
const ASSERTION = "@typescript-eslint/consistent-type-assertions";
const CATCH_CONTINUES = "Catch continues";
const UNARGUED_DISABLE = "Unargued catch-continue disable";
const LOG_ERROR = "Log record drops its error";
const LOG_EVENT_NOT_LITERAL = "Log event name is not a literal";
const LOG_EVENT_MALFORMED = "Log event name `";
const DELIVERY_FILE = join(REPO, "packages", "delivery", "src", "planted.ts");
const FIXED_WAIT = "Fixed wait";
const RAW_WAIT = "Raw wait in production source";
const HAND_BUILT_DEPS = "Hand-built CoreLoopDeps";
const COMPOSE_SOURCE = "Reading a compose module's source text";
const INTEGRATION_TEST_FILE = join(REPO, "packages", "integration", "src", "server", "planted.test.ts");
const EXECUTION_FILE = join(REPO, "packages", "delivery", "src", "execution", "planted.ts");
const REQUEUE_ON_MAIN_FILE = join(REPO, "packages", "delivery", "src", "requeue-on-main.ts");
const REQUEUE_UNREAD = "Requeue unread";
const CHARGE_UNLOCKED = "Charge outside its lock";
const CHARGE_FILE = join(REPO, "packages", "delivery", "src", "infrastructure-fault.ts");
const ADAPTER_FILE = join(REPO, "packages", "delivery", "src", "repositories", "work-item-adapter.ts");

/** The guard each finding of `code`, linted as the file at `filePath` with the repo's config, belongs to. */
async function guardsOf(code: string, filePath = PRODUCTION_FILE): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath });
  expect(results).toHaveLength(1);
  return results.flatMap((result) => result.messages).map((message) => {
    if (message.ruleId === ASSERTION) return ASSERTION;
    if (message.ruleId === "no-restricted-imports" && message.message.includes(REQUEUE_UNREAD)) return REQUEUE_UNREAD;
    if (message.ruleId === "no-restricted-properties" && message.message.includes(CHARGE_UNLOCKED)) return CHARGE_UNLOCKED;
    const guard = [SWALLOWED, IDENTITY, JSON_PARSE, BARE_ERROR, CATCH_CONTINUES, UNARGUED_DISABLE, LOG_ERROR, LOG_EVENT_NOT_LITERAL, LOG_EVENT_MALFORMED, FIXED_WAIT, RAW_WAIT, HAND_BUILT_DEPS, COMPOSE_SOURCE].find((prefix) => message.message.startsWith(prefix));
    return guard ?? `${message.ruleId ?? "parse"}: ${message.message}`;
  });
}

const LOGGER = 'import type { Logger } from "@ashara/shared";\n';
const plantedLogging = (body: string): string =>
  `${LOGGER}export async function planted(logger: Logger, deps: { readonly logger: Logger }, p: Promise<number>, t: string): Promise<unknown> {\n${body}\n}\n`;
const planted = (body: string): string => `export async function planted(p: Promise<number>, x: unknown, t: string): Promise<unknown> {\n${body}\n}\n`;

describe("eslint guards fire on planted instances", () => {
  test.each([
    "p.catch(() => 1);",
    "p.catch((e) => {});",
    "p.catch(function (e) {});",
    "p.catch((e) => null);",
    "p.catch((e) => undefined);",
    "p.catch((e) => void e);",
    "p.catch((e) => -1);",
    "p.catch((e) => []);",
    "p.catch((e) => ({}));",
    "p.catch((e) => `none`);",
    "p.catch((e) => { return null; });",
    "p.catch((e) => { return; });",
    "p.then((v) => v, () => 0);",
    "p.then((v) => v, (e) => {});",
    "p.then((v) => v, (e) => null);",
    "p.then((v) => v, (e) => { return undefined; });",
  ])("swallowed rejection: %s", async (line) => {
    expect(await guardsOf(planted(line))).toEqual([SWALLOWED]);
  });

  test.each([
    "p.catch((e) => { console.warn(e); throw e; });",
    "p.then((v) => null, (e) => { throw e; });",
    "p.then((v) => v);",
  ])("leaves a handler that reports: %s", async (line) => {
    expect(await guardsOf(planted(line))).toEqual([]);
  });

  test.each([
    "return x ?? 0;",
    'return x || "";',
    "return x ?? '';",
    "return x ?? ``;",
    "return x ?? [];",
    "return x || {};",
    "return x ?? false;",
    'return x ?? "unknown";',
    "let n: unknown = x; n ??= 0; return n;",
    "let n: unknown = x; n ||= []; return n;",
    "try { return JSON.stringify(x); } catch { return \"\"; }",
    "try { return JSON.stringify(x); } catch { return false; }",
  ])("identity-element fallback: %s", async (line) => {
    expect(await guardsOf(planted(line))).toEqual([IDENTITY]);
  });

  test.each([
    "return x ?? 1;",
    "return x ?? null;",
    'return x || "(none)";',
    "return x ?? [1];",
    "// eslint-disable-next-line no-restricted-syntax -- policy default: planted\nreturn x ?? 0;",
  ])("leaves a non-identity fallback and an argued one: %s", async (line) => {
    expect(await guardsOf(planted(line))).toEqual([]);
  });

  test("the identity-element and type-assertion guards hold production source only, not tests", async () => {
    expect(await guardsOf(planted("return (x as string) ?? JSON.parse(t) ?? 0;"), TEST_FILE)).toEqual([]);
  });

  test.each(["return x as string;", "return <string>x;"])("type assertion: %s", async (line) => {
    expect(await guardsOf(planted(line))).toEqual([ASSERTION]);
  });

  test("the type-assertion guard leaves `as const`", async () => {
    expect(await guardsOf(planted("return [1, 2] as const;"))).toEqual([]);
  });

  test.each(["return JSON.parse(t);", "return [t].map(JSON.parse);"])("JSON.parse outside parseJson: %s", async (line) => {
    expect(await guardsOf(planted(line))).toEqual([JSON_PARSE]);
  });

  test.each(['throw new Error("planted");', 'throw Error("planted");'])("bare Error: %s", async (line) => {
    expect(await guardsOf(planted(line))).toEqual([BARE_ERROR]);
  });

  test.each([
    "try { await p; } catch (e) { console.warn(e); }",
    "try { await p; } catch { console.warn(t); }",
    "for (const n of [1]) { try { await p; } catch (e) { console.warn(n, e); continue; } }",
    "try { await p; } catch (e) { [e].forEach(() => { return; }); }",
    "try { await p; } catch (e) { class Planted { m(): never { throw e; } } void Planted; }",
  ])("catch that continues: %s", async (line) => {
    expect(await guardsOf(planted(line))).toEqual([CATCH_CONTINUES]);
  });

  test.each([
    "try { await p; } catch (e) {\n// eslint-disable-next-line ashara/catch-continue\nconsole.warn(e); }",
    "try { await p; } catch (e) {\n// eslint-disable-next-line ashara/catch-continue -- the log is enough\nconsole.warn(e); }",
    "try { await p; } catch (e) {\n// eslint-disable-next-line ashara/catch-continue -- best effort:\nconsole.warn(e); }",
  ])("unargued catch-continue disable: %s", async (line) => {
    expect(await guardsOf(planted(line))).toEqual([UNARGUED_DISABLE]);
  });

  test.each([
    "try { await p; } catch (e) {\n// eslint-disable-next-line ashara/catch-continue -- best effort: planted, nothing reads the dropped result\nconsole.warn(e); }",
    "try { await p; } catch (e) { console.warn(e); throw e; }",
    "try { await p; } catch (e) { console.warn(e); return null; }",
    "try { await p; } catch (e) { if (e instanceof RangeError) return 1; throw e; }",
  ])("leaves a catch that exits or is argued: %s", async (line) => {
    expect(await guardsOf(planted(line))).toEqual([]);
  });

  test("the catch-continue rule holds production source only, not tests", async () => {
    expect(await guardsOf(planted("try { await p; } catch (e) { console.warn(e); }"), TEST_FILE)).toEqual([]);
  });

  test.each([
    "await new Promise((resolve) => setTimeout(resolve, 1500));",
    "await new Promise((r) => setTimeout(r, 500));",
    "await new Promise((done) => setTimeout(done, 300));",
    "await new Promise((r) => setTimeout(r, 200));",
    "await new Promise((resolve) => setTimeout(() => resolve(), 1_000));",
    "await sleep(2000);",
    "await sleep(100);",
  ])("a fixed wait in a test: %s", async (line) => {
    const code = `import { setTimeout as sleep } from "node:timers/promises";\nexport async function planted(): Promise<void> {\n  ${line}\n}\n`;
    expect(await guardsOf(code, TEST_FILE)).toEqual([FIXED_WAIT]);
  });

  test.each([
    "await new Promise((r) => setTimeout(r, 99));",
    "await new Promise((_, reject) => setTimeout(() => reject(new Timeout()), 5000));",
  ])("a short wait or a bound on one in a test passes: %s", async (line) => {
    const code = `class Timeout extends Error {}\nexport async function planted(): Promise<void> {\n  ${line}\n}\n`;
    expect(await guardsOf(code, TEST_FILE)).toEqual([]);
  });

  test.each([
    "await new Promise((resolve) => setTimeout(resolve, wait));",
    "await new Promise((r) => setTimeout(r, 1000));",
  ])("a raw wait in production source: %s", async (line) => {
    const code = `export async function planted(wait: number): Promise<void> {\n  ${line}\n}\n`;
    expect(await guardsOf(code)).toEqual([RAW_WAIT]);
  });

  test.each(["node:timers/promises", "timers/promises"])("an import of %s in production source", async (specifier) => {
    const code = `import { setTimeout as sleep } from "${specifier}";\nexport async function planted(wait: number): Promise<void> {\n  await sleep(wait);\n}\n`;
    expect(await guardsOf(code)).toEqual([RAW_WAIT]);
  });

  test("a pause through retryWait, a timer that bounds or ends something, and an argued real wait pass in production source", async () => {
    const code = [
      'import { retryWait } from "@ashara/shared";',
      "export async function planted(wait: number, signal: AbortSignal): Promise<void> {",
      "  await retryWait(wait);",
      "  const timer = setTimeout(() => signal.dispatchEvent(new Event(\"abort\")), wait);",
      "  clearTimeout(timer);",
      "  // eslint-disable-next-line no-restricted-syntax -- real wait: planted, a server must end its sessions first",
      "  await new Promise((resolve) => setTimeout(resolve, wait));",
      "}",
      "",
    ].join("\n");
    expect(await guardsOf(code)).toEqual([]);
  });

  test("a typed error class is not a bare Error", async () => {
    const code = 'class Planted extends Error {}\nexport function planted(): never {\n  throw new Planted("planted");\n}\n';
    expect(await guardsOf(code)).toEqual([]);
  });

  test.each([
    'try { await p; } catch (e) { logger.warn("shared.planted", "planted", {}); throw e; }',
    'try { await p; } catch (e) { deps.logger.error("shared.planted", "planted", {}); throw e; }',
    'try { await p; } catch (e) { logger.warn("shared.planted", "planted", {}, t); throw e; }',
    'try { await p; } catch { logger.warn("shared.planted", "planted", {}); throw new RangeError(t); }',
    'class PlantedFault extends Error {}\nconst fault = new PlantedFault(t);\nlogger.error("shared.planted", "planted", {});\nthrow fault;',
  ])("a warn/error record that drops its error: %s", async (body) => {
    expect(await guardsOf(plantedLogging(body))).toEqual([LOG_ERROR]);
  });

  test.each([
    'try { await p; } catch (e) { logger.warn("shared.planted", "planted", {}, e); throw e; }',
    'try { await p; } catch (e) { const fault = new RangeError(t, { cause: e }); logger.error("shared.planted", "planted", {}, fault); throw fault; }',
    'try { await p; } catch (e) { logger.info("shared.planted", "planted", {}); throw e; }',
    'class PlantedFault extends Error {}\nconst fault = new PlantedFault(t);\nlogger.error("shared.planted", "planted", {}, fault);\nthrow fault;',
    'const seen = new Set<string>();\nlogger.warn("shared.planted", "planted", { seen: [...seen] });',
  ])("leaves a record that carries its error: %s", async (body) => {
    expect(await guardsOf(plantedLogging(body))).toEqual([]);
  });

  test.each([
    ['logger.info("delivery.Bad_Name", "planted");', LOG_EVENT_MALFORMED],
    ['logger.info("quality.planted", "planted");', LOG_EVENT_MALFORMED],
    ['logger.info("delivery.planted.sub", "planted");', LOG_EVENT_MALFORMED],
    ['logger.debug(t, "planted");', LOG_EVENT_NOT_LITERAL],
    ["deps.logger.warn(`delivery.${t}`, \"planted\", {});", LOG_EVENT_NOT_LITERAL],
  ])("a log event name that is not `<package>.<kebab-case>`: %s", async (body, guard) => {
    expect(await guardsOf(plantedLogging(body), DELIVERY_FILE)).toEqual([guard]);
  });

  test("leaves an event name of the file's own package in kebab case", async () => {
    expect(await guardsOf(plantedLogging('logger.info("delivery.planted-2", "planted");'), DELIVERY_FILE)).toEqual([]);
  });

  test.each([
    "const deps: CoreLoopDeps = { loop, client, planning, dispatch, sweeps, reporting };",
    "const deps = { loop, client, planning, dispatch, sweeps, reporting } satisfies CoreLoopDeps;",
    "function loopDeps(): CoreLoopDeps { return { loop, client, planning, dispatch, sweeps, reporting }; }",
    "const loopDeps = (): CoreLoopDeps => ({ loop, client, planning, dispatch, sweeps, reporting });",
    "const deps = withOverrides({ loop, client, planning, dispatch, sweeps, reporting }, {});",
    "const loop = new CoreLoop({ loop, client, planning, dispatch, sweeps, reporting });",
  ])("a hand-built CoreLoopDeps, in a test as in production: %s", async (line) => {
    expect(await guardsOf(line, INTEGRATION_TEST_FILE)).toEqual([HAND_BUILT_DEPS]);
    expect(await guardsOf(line, DELIVERY_FILE)).toEqual([HAND_BUILT_DEPS]);
  });

  test.each([
    "const deps: CoreLoopDeps = composeCoreLoopDeps(parts, { loop: { spendCap } });",
    "const deps: CoreLoopDeps = withOverrides(inertCoreLoopDeps(), { loop: { logger } });",
    "const loop = new CoreLoop(composedLoopOverTestDb(parts));",
  ])("leaves deps built by a builder: %s", async (line) => {
    expect(await guardsOf(line, INTEGRATION_TEST_FILE)).toEqual([]);
  });

  test.each([
    'const compose = readFileSync(join(import.meta.dirname, "compose.ts"), "utf-8");',
    'const compose = fs.readFileSync(`${dir}/compose-core-loop.ts`, "utf-8");',
    'const compose = await readFile(join(dir, "compose.ts"), "utf-8");',
  ])("a test reading a compose module's source text: %s", async (line) => {
    expect(await guardsOf(line, TEST_FILE)).toEqual([COMPOSE_SOURCE]);
  });

  test.each([
    ['import { requeueWorkItem } from "./domain/index.js";\nexport const planted = requeueWorkItem;', DELIVERY_FILE],
    ['import { unblockWorkItem } from "./domain/index.js";\nexport const planted = unblockWorkItem;', DELIVERY_FILE],
    ['import { resumeOnAnswer } from "./domain/prerequisite-wait.js";\nexport const planted = resumeOnAnswer;', DELIVERY_FILE],
    ['import { requeueWorkItem } from "../domain/work-item.js";\nexport const planted = requeueWorkItem;', EXECUTION_FILE],
    ['import { mergeOnMainOf } from "../orphan-merge.js";\nexport const planted = mergeOnMainOf;', EXECUTION_FILE],
  ])("a return to Pending, or a read of main, outside requeue-on-main.ts: %s", async (code, filePath) => {
    expect(await guardsOf(code, filePath)).toEqual([REQUEUE_UNREAD]);
  });

  test.each([
    ['import { takeEvents } from "./domain/index.js";\nexport const planted = takeEvents;', DELIVERY_FILE],
    ['import { requeueWorkItem, unblockWorkItem } from "./domain/index.js";\nexport const planted = [requeueWorkItem, unblockWorkItem];', REQUEUE_ON_MAIN_FILE],
    ['import { mergeOnMainOf } from "./orphan-merge.js";\nexport const planted = mergeOnMainOf;', REQUEUE_ON_MAIN_FILE],
  ])("leaves another domain import, and requeue-on-main.ts's own: %s", async (code, filePath) => {
    expect(await guardsOf(code, filePath)).toEqual([]);
  });

  test.each([
    ["export const planted = (repo: { recordInfrastructureFault(id: string): Promise<number> }) => repo.recordInfrastructureFault(\"t\");", EXECUTION_FILE],
    ["export const planted = (repo: { withItemLocked(): Promise<number> }) => repo.withItemLocked();", DELIVERY_FILE],
    ["export const planted = (deps: { workItemRepo: { withItemLocked(): Promise<number> } }) => deps.workItemRepo.withItemLocked();", REQUEUE_ON_MAIN_FILE],
  ])("a charge's lock or count reached outside chargeInfrastructureFault: %s", async (code, filePath) => {
    expect(await guardsOf(code, filePath)).toEqual([CHARGE_UNLOCKED]);
  });

  test.each([
    ["export const planted = (repo: { withItemLocked(): Promise<number> }) => repo.withItemLocked();", CHARGE_FILE],
    ["export const planted = (repo: { recordInfrastructureFault(id: string): Promise<number> }) => repo.recordInfrastructureFault(\"t\");", ADAPTER_FILE],
  ])("leaves the charge's own module and the adapter that builds its ledger: %s", async (code, filePath) => {
    expect(await guardsOf(code, filePath)).toEqual([]);
  });
});

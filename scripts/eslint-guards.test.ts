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

/** The guard each finding of `code`, linted as the file at `filePath` with the repo's config, belongs to. */
async function guardsOf(code: string, filePath = PRODUCTION_FILE): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath });
  expect(results).toHaveLength(1);
  return results.flatMap((result) => result.messages).map((message) => {
    if (message.ruleId === ASSERTION) return ASSERTION;
    const guard = [SWALLOWED, IDENTITY, JSON_PARSE, BARE_ERROR, CATCH_CONTINUES, UNARGUED_DISABLE].find((prefix) => message.message.startsWith(prefix));
    return guard ?? `${message.ruleId ?? "parse"}: ${message.message}`;
  });
}

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

  test("a typed error class is not a bare Error", async () => {
    const code = 'class Planted extends Error {}\nexport function planted(): never {\n  throw new Planted("planted");\n}\n';
    expect(await guardsOf(code)).toEqual([]);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { forgetPrograms, moduleProgram, overriddenProgram, programHolding } from "./module-program.js";
import { WHOLE_TREE_ENV, WHOLE_TREE_TEST } from "../packages/integration/src/test-run-load.js";

// A build makes a new ts.Program every time, so a call answered by the same program object is one
// that built nothing.

const ROOT = path.join(os.tmpdir(), "module-program-probe");
const A = path.join(ROOT, "a.ts");
const B = path.join(ROOT, "b.ts");
const TEXTS: readonly [string, string][] = [
  [A, 'import { b } from "./b.js";\nexport const a: number = b + 1;\n'],
  [B, "export const b = 1;\n"],
];

afterEach(() => {
  forgetPrograms();
});

describe("the program over every source of this checkout", () => {
  test("is refused in every test file but the one that builds it once for the run, which the refusal names", () => {
    expect(process.env[WHOLE_TREE_ENV]).toBe("refused");
    const file = path.join(import.meta.dirname, "module-program.ts");
    expect(() => programHolding(file, fs.readFileSync(file, "utf-8"))).toThrow(WHOLE_TREE_TEST);
  });
});

describe("kept programs", () => {
  test("a second program over unchanged texts is the kept one, its checker the same", () => {
    const first = moduleProgram(ROOT, new Map(TEXTS));
    const second = moduleProgram(ROOT, new Map(TEXTS));
    expect(second).toBe(first);
    expect(second.program).toBe(first.program);
    expect(second.checker).toBe(first.checker);
  });

  test("a second overridden program over unchanged overrides is the kept one", () => {
    const built = moduleProgram(ROOT, new Map(TEXTS));
    const overrides = new Map([[path.join(ROOT, "probe.ts"), 'import { a } from "./a.js";\nexport const c = a;\n']]);
    const first = overriddenProgram(built, overrides);
    const second = overriddenProgram(built, new Map(overrides));
    expect(second).toBe(first);
    expect(second.program).toBe(first.program);
    expect(first.program).not.toBe(built.program);
  });

  test("a program over texts that differ from the last one's in one module reuses the parsed source of every other", () => {
    const first = moduleProgram(ROOT, new Map(TEXTS));
    const second = moduleProgram(ROOT, new Map([...TEXTS, [B, "export const b = 2;\n"]]));
    expect(second).not.toBe(first);
    expect(second.program.getSourceFile(A)).toBe(first.program.getSourceFile(A));
    expect(second.program.getSourceFile(B)).not.toBe(first.program.getSourceFile(B));
    expect(second.program.getSourceFile(B)?.text).toBe("export const b = 2;\n");
  });
});

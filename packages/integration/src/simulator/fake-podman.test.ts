import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJson } from "@ashara/shared";
import { FakePodman } from "./fake-podman.js";
import { Tape } from "./tape.js";

const BASE_IMAGE = "localhost/ashara-base:sim";
const rowsSchema = z.array(z.object({ Id: z.string(), Labels: z.record(z.string(), z.string()) }));

function fakePodman(): FakePodman {
  return new FakePodman({ baseImage: BASE_IMAGE, tape: new Tape({ kind: "replay", decisions: [] }), observe: () => undefined });
}

async function podman(fake: FakePodman, args: readonly string[]): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  return fake.runner({ file: "podman", args, env: {}, maxOutputBytes: 1_000_000 });
}

async function startCell(fake: FakePodman, name: string, labels: Readonly<Record<string, string>>): Promise<void> {
  const labelArgs = Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  const started = await podman(fake, ["run", "-d", "--name", name, ...labelArgs, BASE_IMAGE, "sleep", "infinity"]);
  expect(started.exitCode, started.stderr).toBe(0);
}

async function listedNames(fake: FakePodman, filters: readonly string[]): Promise<string[]> {
  const listed = await podman(fake, ["ps", "-a", ...filters.flatMap((filter) => ["--filter", filter]), "--format", "json"]);
  expect(listed.exitCode, listed.stderr).toBe(0);
  return parseJson(rowsSchema, listed.stdout, "fake podman ps")
    .map((row) => fake.liveCells().find((cell) => cell.id === row.Id)?.name)
    .filter((name): name is string => name !== undefined)
    .sort();
}

describe("FakePodman label filters", () => {
  it("a key-only filter lists the rows carrying that key, with any value, and never an unlabelled row", async () => {
    const fake = fakePodman();
    await startCell(fake, "a", { "ashara.instance": "w-1", "ashara.managed": "1" });
    await startCell(fake, "b", { "ashara.instance": "w-2" });
    await startCell(fake, "c", { "ashara.managed": "1" });
    await startCell(fake, "d", {});
    expect(await listedNames(fake, ["label=ashara.instance"])).toEqual(["a", "b"]);
  });

  it("a key=value filter matches that value exactly, and repeated filters are OR-ed", async () => {
    const fake = fakePodman();
    await startCell(fake, "a", { "ashara.instance": "w-1", "ashara.managed": "1" });
    await startCell(fake, "b", { "ashara.instance": "w-2" });
    await startCell(fake, "c", { "ashara.instance": "" });
    expect(await listedNames(fake, ["label=ashara.instance=w-1"])).toEqual(["a"]);
    expect(await listedNames(fake, ["label=ashara.instance="])).toEqual(["c"]);
    expect(await listedNames(fake, ["label=ashara.instance=w-2", "label=ashara.managed=1"])).toEqual(["a", "b"]);
  });

  it("a filter it cannot interpret is refused, never dropped into a listing of every row", async () => {
    const fake = fakePodman();
    await startCell(fake, "a", {});
    const listed = await podman(fake, ["ps", "-a", "--filter", "status=running", "--format", "json"]);
    expect(listed.exitCode).toBe(125);
    expect(listed.stderr).toContain("status=running");
  });
});

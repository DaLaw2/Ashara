import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBaseCell } from "./base-cell.js";
import { BaseCellConfigInvalid } from "./errors.js";

const dirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ashara-base-cell-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadBaseCell", () => {
  it("fails closed on a missing BaseCell file", async () => {
    const dir = await scratch();
    await expect(loadBaseCell(join(dir, "absent.toml"))).rejects.toBeInstanceOf(BaseCellConfigInvalid);
  });

  it("fails closed on a reference without a digest", async () => {
    const tagOnly = join(await scratch(), "base-cell.toml");
    await writeFile(tagOnly, 'image = "docker.io/library/debian:12-slim"\n');
    await expect(loadBaseCell(tagOnly)).rejects.toBeInstanceOf(BaseCellConfigInvalid);
  });

  it("reads a reference pinned by digest", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const pinned = join(await scratch(), "base-cell.toml");
    await writeFile(pinned, `image = "docker.io/library/debian:12-slim@${digest}"\n`);
    expect(await loadBaseCell(pinned)).toEqual({ image: `docker.io/library/debian:12-slim@${digest}`, digest });
  });
});

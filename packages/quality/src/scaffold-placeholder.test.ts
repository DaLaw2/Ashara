import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PUBLIC_INTERFACE_FILE } from "./public-interface.js";
import { placeholderDefectLine, placeholderMarkersAt, SCAFFOLD_PLACEHOLDER_MARKER, scaffoldUnmarkedLine } from "./scaffold-placeholder.js";

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

/** A repository whose main holds `files`, and the commit that holds them. */
async function repoWith(files: Readonly<Record<string, string | Buffer>>): Promise<{ readonly repo: string; readonly commit: string }> {
  const repo = await mkdtemp(join(tmpdir(), "placeholder-marker-test-"));
  scratch.push(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "main");
  return { repo, commit: git("rev-parse", "HEAD") };
}

describe("placeholderMarkersAt", () => {
  let marked: { readonly repo: string; readonly commit: string };
  beforeAll(async () => {
    marked = await repoWith({
      "public/index.php": `<?php\nroute('/members/{id:\\d+}', 'show');\nhttp_response_code(501); echo '{"error":"not done: ${SCAFFOLD_PLACEHOLDER_MARKER}"}'; // ${SCAFFOLD_PLACEHOLDER_MARKER}\n`,
      "src/main.c": `int main(void) { return 0; }\n`,
      "dir: odd/new\nline.txt": `\n\n${SCAFFOLD_PLACEHOLDER_MARKER}\n`,
      "build/placeholder.bin": Buffer.concat([Buffer.from([0, 1, 2, 10, 0]), Buffer.from(SCAFFOLD_PLACEHOLDER_MARKER), Buffer.from([0, 255])]),
    });
  });

  test("names every tracked file and line still holding the marker, each line once, whatever the language or file name", async () => {
    const hits = await placeholderMarkersAt(marked.repo, marked.commit);
    expect(hits).toEqual([
      { file: "build/placeholder.bin", line: 2 },
      { file: "dir: odd/new\nline.txt", line: 3 },
      { file: "public/index.php", line: 3 },
    ]);
    expect(placeholderDefectLine(hits)).toContain("at build/placeholder.bin:2, dir: odd/new\nline.txt:3, public/index.php:3");
  });

  test("a binary file holding the marker is a hit: its bytes are searched as text", async () => {
    const { repo, commit } = await repoWith({ "app.wasm": Buffer.concat([Buffer.from([0, 97, 115, 109]), Buffer.from(SCAFFOLD_PLACEHOLDER_MARKER), Buffer.from([0])]) });
    expect(await placeholderMarkersAt(repo, commit)).toEqual([{ file: "app.wasm", line: 1 }]);
  });

  test("a main without the marker has no hit and no defect line", async () => {
    const { repo, commit } = await repoWith({ "src/main.c": "int main(void) { return 0; }\n", "README": "ashara-scaffold-refusal\n" });
    expect(await placeholderMarkersAt(repo, commit)).toEqual([]);
    expect(placeholderDefectLine([])).toBeNull();
  });

  test("a commit that is not a commit id is never handed to git, and a commit git cannot read throws, never reads as clean", async () => {
    await expect(placeholderMarkersAt(marked.repo, "--output=/tmp/x")).rejects.toMatchObject({ name: "MarkerCommitInvalid" });
    await expect(placeholderMarkersAt(marked.repo, "0".repeat(40))).rejects.toMatchObject({ name: "MarkerSearchFailed" });
  });
});

describe("scaffoldUnmarkedLine", () => {
  test("a scaffold merge with a marked refusal in a product file is not refused for it", () => {
    expect(scaffoldUnmarkedLine([{ file: "src/main.rs", line: 4 }])).toBeNull();
    expect(scaffoldUnmarkedLine([{ file: PUBLIC_INTERFACE_FILE, line: 1 }, { file: "firmware/boot.S", line: 9 }])).toBeNull();
  });

  test("a scaffold merge with no marker, or the marker only in the interface file, is refused naming the marker", () => {
    for (const hits of [[], [{ file: PUBLIC_INTERFACE_FILE, line: 3 }]]) {
      expect(scaffoldUnmarkedLine(hits)).toContain(`holds no placeholder refusal marked ${SCAFFOLD_PLACEHOLDER_MARKER}`);
    }
  });

  test("read from a real scaffold tree: no marked file refuses it, a marked one does not", async () => {
    const unmarked = await repoWith({ "src/main.c": "int main(void) { puts(\"not done yet\"); return 1; }\n" });
    expect(scaffoldUnmarkedLine(await placeholderMarkersAt(unmarked.repo, unmarked.commit))).not.toBeNull();
    const marked = await repoWith({ "src/main.c": `int main(void) { puts("${SCAFFOLD_PLACEHOLDER_MARKER}"); return 1; }\n` });
    expect(scaffoldUnmarkedLine(await placeholderMarkersAt(marked.repo, marked.commit))).toBeNull();
  });
});

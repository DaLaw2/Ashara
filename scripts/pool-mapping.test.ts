import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { exportPacket, MappingFileInvalid, packetText, parseMappingFile, PoolMappingRefused, readingOrder, refuseInsideGitTree } from "./pool-mapping.js";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const SEED = "5".repeat(64);
const VERDICTS = ["pass", "fail", "unjudged"];
const EVIDENCE = ["interface-probe-evidence", "stored-row-evidence"];
const BASES = ["client-stated", "assumed-unconfirmed", "derived"];
const ARMS = ["ashara", "baseline", "qa3"];

function source(arm: string): Record<string, unknown> {
  return {
    version: 1,
    run: "run-fixture",
    arm,
    intended: [
      { id: "I1", statement: "Adding a meter reading prints its new total" },
      { id: "I2", statement: "An unknown meter is refused with a nonzero exit" },
    ],
    items: [
      { id: "G1", statement: "Readings are summed per meter", observations: ["the total line"], verdict: "pass", evidence: EVIDENCE[0], basis: "client-stated" },
      { id: "G2", statement: "Unknown meters exit nonzero", observations: [], verdict: "fail", evidence: EVIDENCE[1], basis: "derived" },
      { id: "G3", statement: "Totals survive a restart", observations: ["the stored rows"], verdict: "unjudged", evidence: null, basis: "assumed-unconfirmed" },
      { id: "G4", statement: "Readings below zero are refused", observations: [], verdict: "pass", evidence: EVIDENCE[1], basis: null },
      { id: "G5", statement: "The report lists meters by name", observations: ["the listing"], verdict: "fail", evidence: null, basis: "derived" },
    ],
  };
}

function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const entry of value) strings(entry, into);
  else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.push(key);
      strings(entry, into);
    }
  }
  return into;
}

function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

describe("mapping packet", () => {
  test("holds no verdict, evidence class, basis, arm name or arm item id, in any key or value", () => {
    const { packet } = exportPacket(source("baseline"), SEED);
    const found = strings(packet);
    const forbidden = [...VERDICTS, ...EVIDENCE, ...BASES, ...ARMS, "G1", "G2", "G3", "G4", "G5", "verdict", "evidence", "basis", "arm"];
    for (const text of found) {
      for (const word of forbidden) expect(text.toLowerCase().includes(word.toLowerCase()), `${JSON.stringify(text)} carries ${word}`).toBe(false);
    }
    expect(packet.items.map((item) => item.label)).toEqual(["item-1", "item-2", "item-3", "item-4", "item-5"]);
    expect(packet.items[0]?.statement).toBe("Unknown meters exit nonzero");
  });

  test("the key joins each label back to the arm's own item", () => {
    const { key } = exportPacket(source("ashara"), SEED);
    expect(key.arm).toBe("ashara");
    expect(key.items).toEqual([
      { label: "item-1", id: "G2" },
      { label: "item-2", id: "G4" },
      { label: "item-3", id: "G5" },
      { label: "item-4", id: "G3" },
      { label: "item-5", id: "G1" },
    ]);
  });
});

describe("reading order", () => {
  test("is fixed by the seed and does not depend on the arm", () => {
    expect(readingOrder(SEED, ["G1", "G2", "G3", "G4", "G5"])).toEqual(["G2", "G4", "G5", "G3", "G1"]);
    expect(readingOrder(SEED, ["G5", "G4", "G3", "G2", "G1"])).toEqual(["G2", "G4", "G5", "G3", "G1"]);
    const orders = ARMS.map((arm) => exportPacket(source(arm), SEED).packet);
    expect(orders[1]).toEqual(orders[0]);
    expect(orders[2]).toEqual(orders[0]);
  });

  test("a seed that is not a sha256 hex digest is refused", () => {
    expect(() => readingOrder("not-a-seed", ["G1"])).toThrow(PoolMappingRefused);
  });
});

describe("mapping file", () => {
  const { packet } = exportPacket(source("ashara"), SEED);
  const packetDigest = digest(packetText(packet));

  function file(entries: readonly string[]): string {
    return [`version = 1`, `run = "run-fixture"`, `packet = "${packetDigest}"`, "", ...entries].join("\n");
  }

  const mapI1 = `[[map]]\nintended = "I1"\nto = ["item-5"]\nnarrowed = false\n`;
  const mapI2 = `[[map]]\nintended = "I2"\nto = []\nnarrowed = false\n`;

  function refusal(text: string): MappingFileInvalid {
    try {
      parseMappingFile(text, "reader-B.toml", packet, packetDigest);
    } catch (err) {
      if (err instanceof MappingFileInvalid) return err;
      throw err;
    }
    throw new Error("the mapping file was accepted");
  }

  test("naming every intended id once is accepted", () => {
    const parsed = parseMappingFile(file([mapI1, mapI2]), "reader-A.toml", packet, packetDigest);
    expect(parsed.map.map((entry) => entry.intended)).toEqual(["I1", "I2"]);
  });

  test("missing an intended id is refused naming it", () => {
    const err = refusal(file([mapI1]));
    expect(err.intended).toBe("I2");
    expect(err.message).toMatch(/missing/);
  });

  test("naming an intended id twice is refused naming it", () => {
    const err = refusal(file([mapI1, mapI2, mapI1]));
    expect(err.intended).toBe("I1");
    expect(err.message).toMatch(/twice/);
  });

  test("an id off the intended list, an unknown label, or another packet's digest is refused", () => {
    expect(refusal(file([mapI1, mapI2, `[[map]]\nintended = "I9"\nto = []\nnarrowed = false\n`])).intended).toBe("I9");
    expect(refusal(file([mapI1, `[[map]]\nintended = "I2"\nto = ["item-6"]\nnarrowed = false\n`])).intended).toBe("I2");
    expect(refusal(file([mapI1, mapI2]).replace(packetDigest, digest("another packet"))).intended).toBeNull();
  });
});

describe("output path", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pool-mapping-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("inside the git work tree is refused", () => {
    let caught: unknown;
    try {
      refuseInsideGitTree(path.join(SCRIPTS, "packet.json"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PoolMappingRefused);
    expect(caught instanceof PoolMappingRefused ? caught.status : 0).toBe(2);
    expect(caught instanceof PoolMappingRefused ? caught.detail : "").toMatch(/is inside the git work tree/);
  });

  test("outside every work tree is allowed", () => {
    expect(() => refuseInsideGitTree(path.join(dir, "packet.json"))).not.toThrow();
  });
});

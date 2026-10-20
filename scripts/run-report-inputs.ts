/**
 * The operator's files a run is judged from, beside its database: the hidden suite's verdict file and a reader's
 * mapping file with the packet key that joins its item labels to the arm's own item ids. One reader for each, shared
 * by scripts/run-report.ts and the trust ledger's append command, so both parse a file the same way. A file that
 * cannot be read or parsed throws; nothing here reads as an empty verdict or mapping.
 */

import { readFile } from "node:fs/promises";
import { parseJson } from "@ashara/shared";
import { judgedVerdictSchema, type JudgedVerdict } from "./hidden-verdict.js";
import { digestOf, readMappingFile, readPacketKey } from "./pool-mapping.js";
import type { GuaranteeMapping } from "./run-report-format.js";

class HiddenVerdictUnreadable extends Error {
  constructor(
    readonly path: string,
    options: ErrorOptions,
  ) {
    super(`the hidden verdict file ${JSON.stringify(path)} cannot be read`, options);
    this.name = "HiddenVerdictUnreadable";
  }
}

class MappingInputUnreadable extends Error {
  constructor(
    readonly what: "mapping file" | "packet key",
    readonly path: string,
    options: ErrorOptions,
  ) {
    super(`the ${what} ${JSON.stringify(path)} cannot be read`, options);
    this.name = "MappingInputUnreadable";
  }
}

/** The judged verdict scripts/hidden-suite.ts wrote at `path`; `command` names the caller in a parse error. */
export async function readHidden(path: string, command: string): Promise<JudgedVerdict> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new HiddenVerdictUnreadable(path, { cause: err });
  }
  return parseJson(judgedVerdictSchema, text, `${command} --hidden ${path}`);
}

async function readInput(what: "mapping file" | "packet key", path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new MappingInputUnreadable(what, path, { cause: err });
  }
}

/** A reader's mapping, with the digest of the mapping file's bytes as read, the one its ledger row records. */
export interface ReadMapping extends GuaranteeMapping {
  readonly fileDigest: string;
}

/** The mapping file at `mappingPath`, read on its own, and the packet key at `keyPath`; `command` names the caller. */
export async function readMapping(mappingPath: string, keyPath: string, command: string): Promise<ReadMapping> {
  const text = await readInput("mapping file", mappingPath);
  const file = readMappingFile(text, mappingPath);
  const key = readPacketKey(await readInput("packet key", keyPath), `${command} --key ${keyPath}`);
  return { file, key, fileDigest: digestOf(text) };
}

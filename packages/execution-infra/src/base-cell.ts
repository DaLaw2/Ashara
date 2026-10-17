import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import { BaseCellConfigInvalid } from "./errors.js";

/** Module-anchored, so the server's cwd cannot change which file is read. */
const DEFAULT_BASE_CELL_PATH = fileURLToPath(new URL("../../../config/base-cell.toml", import.meta.url));

const DIGEST_PATTERN = /@(sha256:[0-9a-f]{64})$/;

const baseCellSchema = z
  .object({
    image: z
      .string()
      .regex(/^[^\s-][^\s@]*@sha256:[0-9a-f]{64}$/, "image must be a reference pinned by @sha256:<64 hex> digest"),
  })
  .strict();

export interface BaseCellReference {
  /** Opaque reference handed to CellSpec.image. */
  readonly image: string;
  /** The pinned digest, recorded per attempt. */
  readonly digest: string;
}

/**
 * Loads the BaseCell reference. A missing file, a reference without a
 * digest, or any extra key fails closed.
 */
export async function loadBaseCell(path: string = DEFAULT_BASE_CELL_PATH): Promise<BaseCellReference> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new BaseCellConfigInvalid(path, `cannot read the file: ${describeErrorChain(err)}`, { cause: err });
  }
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (err) {
    throw new BaseCellConfigInvalid(path, `invalid TOML: ${describeErrorChain(err)}`, { cause: err });
  }
  const parsed = baseCellSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BaseCellConfigInvalid(
      path,
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
    );
  }
  const digest = DIGEST_PATTERN.exec(parsed.data.image)?.[1];
  if (digest === undefined) throw new BaseCellConfigInvalid(path, "image carries no sha256 digest");
  return { image: parsed.data.image, digest };
}

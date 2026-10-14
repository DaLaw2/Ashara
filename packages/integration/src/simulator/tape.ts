import { z } from "zod";
import { PROFILES } from "./profile.js";

/**
 * One choice a run made that is not its benign value. `key` is the choice's site and its
 * occurrence there (`agent.over-delivery#3`), so a replay finds the same choice even when an
 * earlier, removed decision changed how many draws other sites made.
 */
export interface Decision {
  readonly key: string;
  readonly value: number;
}

const DecisionSchema = z.strictObject({ key: z.string().min(1), value: z.number().int() });

/**
 * The seeded value of one draw: a pure function of the seed and the draw's key (FNV-1a of the
 * key, mixed with the seed, then one mulberry32 step), the same on every platform. Not a shared
 * stream: a production change that adds or removes a seam call re-rolls that call's own site
 * only, so a seed keeps naming the same scenario everywhere else (the hardening of 31aefa1d added
 * one boot query and, under a stream, re-rolled every fast-tier seed).
 */
function seededUniform(seed: number, key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193) >>> 0;
  let t = (Math.imul(hash ^ (seed >>> 0), 0x9e3779b1) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export type TapeMode =
  | { readonly kind: "seeded"; readonly seed: number }
  /** Every decision not listed takes its benign value: the minimiser and `--replay` run this way. */
  | { readonly kind: "replay"; readonly decisions: readonly Decision[] };

/**
 * Every random choice of a run (adversary event, fault, crash point) is read here. Value 0 is the
 * benign one at every site: no fault, no adversary, the first option.
 */
export class Tape {
  private readonly counts = new Map<string, number>();
  private readonly taken: Decision[] = [];
  private readonly seed: number | null;
  private readonly fixed: ReadonlyMap<string, number> | null;

  constructor(readonly mode: TapeMode) {
    if (mode.kind === "seeded") {
      this.seed = mode.seed;
      this.fixed = null;
    } else {
      this.seed = null;
      this.fixed = new Map(mode.decisions.map((decision) => [decision.key, decision.value]));
    }
  }

  private draw(site: string, choose: (u: number) => number): number {
    const occurrence = (this.counts.get(site) ?? 0) + 1;
    this.counts.set(site, occurrence);
    const key = `${site}#${occurrence}`;
    const value = this.seed === null ? (this.fixed?.get(key) ?? 0) : choose(seededUniform(this.seed, key));
    if (value !== 0) this.taken.push({ key, value });
    return value;
  }

  /** True with probability `p`; false is benign. */
  chance(site: string, p: number): boolean {
    return this.draw(site, (u) => (u < p ? 1 : 0)) === 1;
  }

  /** 0..n-1, uniform; 0 is benign. */
  pick(site: string, n: number): number {
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`Tape.pick(${site}): n must be a positive integer, got ${n}`);
    return this.draw(site, (u) => Math.min(n - 1, Math.floor(u * n)));
  }

  /** The non-benign decisions taken so far, in order. */
  decisions(): readonly Decision[] {
    return [...this.taken];
  }

  /** How many draws a site made: what the coverage report counts. */
  draws(): ReadonlyMap<string, number> {
    return new Map(this.counts);
  }
}

/** A failing run as `just simulate --replay` reads it back: the seed, its profile and its decisions. */
export const ReplayFileSchema = z.strictObject({
  seed: z.number().int(),
  profile: z.enum(PROFILES),
  decisions: z.array(DecisionSchema),
});

import { z } from "zod";
import type { FaultKind, SeamKind } from "./faults.js";
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

/** A site named exactly, or every site a pattern matches. */
type SiteMatch = string | RegExp;

/**
 * One behaviour a directed run forces (simulator-harness.ts directed), named by what it is rather than by a
 * seed that happens to reach it, so a production change that adds or moves a seam call cannot
 * move it off its behaviour:
 * - draw: the `nth` draw (or `every` draw) of a matching site takes `value`; `scope` narrows the
 *   count to the draws made for one kind of work (the stand-ins pass `implementation`,
 *   `environment`, `checks` or `scaffold`). The interleaver's draws are sites too: a draw on
 *   `interleave:<seam>:<label>` valued 1 hands the turn to the other task of the batch there;
 * - fault: the `nth` seam call of `seam` whose label matches carries `fault` (Scheduler.enter), in
 *   no budget's count; a fault the call cannot carry is not injected and the direction stays untaken.
 */
export type Direction =
  | {
      readonly kind: "draw";
      readonly site: SiteMatch;
      readonly scope?: string;
      readonly nth: number | "every";
      readonly value: number;
    }
  | { readonly kind: "fault"; readonly seam: SeamKind; readonly label: SiteMatch; readonly nth: number; readonly fault: FaultKind };

export type TapeMode =
  | { readonly kind: "seeded"; readonly seed: number }
  /** Every decision not listed takes its benign value: the minimiser and `--replay` run this way. */
  | { readonly kind: "replay"; readonly decisions: readonly Decision[] }
  /** Every draw benign but the directions: the fast tier forces each behaviour it judges this way. */
  | { readonly kind: "directed"; readonly directions: readonly Direction[] };

/** A replayed or directed value its draw cannot take: the tape and the site it met disagree. */
class DrawOutOfRange extends Error {
  constructor(
    readonly site: string,
    readonly value: number,
    readonly n: number,
  ) {
    super(`the tape gives ${site} the value ${value}, but that draw takes 0..${n - 1}`);
    this.name = "DrawOutOfRange";
  }
}

function matches(match: SiteMatch, site: string): boolean {
  return typeof match === "string" ? match === site : match.test(site);
}

/** What one direction met while the run went on. */
interface DirectionState {
  readonly direction: Direction;
  seen: number;
  taken: number;
  /** Why its nth match did not take it, when it did not. */
  refused: string | null;
}

/** How a direction is named in an error and the trace. */
function describeDirection(direction: Direction): string {
  const at = direction.kind === "draw" ? `${String(direction.site)}${direction.scope === undefined ? "" : ` (${direction.scope})`}` : `${direction.seam} ${String(direction.label)}`;
  const what = direction.kind === "draw" ? `= ${direction.value}` : direction.fault;
  return `${direction.kind} ${at} #${direction.nth} ${what}`;
}

/**
 * Every random choice of a run (adversary event, fault, crash point) is read here. Value 0 is the
 * benign one at every site: no fault, no adversary, the first option.
 */
export class Tape {
  private readonly counts = new Map<string, number>();
  private readonly taken: Decision[] = [];
  private readonly seed: number | null;
  private readonly fixed: ReadonlyMap<string, number> | null;
  private readonly directions: readonly DirectionState[];

  constructor(readonly mode: TapeMode) {
    this.seed = mode.kind === "seeded" ? mode.seed : null;
    this.fixed = mode.kind === "replay" ? new Map(mode.decisions.map((decision) => [decision.key, decision.value])) : null;
    this.directions = mode.kind === "directed" ? mode.directions.map((direction) => ({ direction, seen: 0, taken: 0, refused: null })) : [];
  }

  private draw(site: string, scope: string | undefined, choose: (u: number) => number, n: number): number {
    // eslint-disable-next-line no-restricted-syntax -- policy default: a site not yet drawn has drawn 0 times, the counter's start
    const occurrence = (this.counts.get(site) ?? 0) + 1;
    this.counts.set(site, occurrence);
    const key = `${site}#${occurrence}`;
    let value: number;
    if (this.seed !== null) value = choose(seededUniform(this.seed, key));
    // eslint-disable-next-line no-restricted-syntax -- policy default: a replay file records only the non-zero draws (taken below), so an absent key is the zero draw
    else if (this.fixed !== null) value = this.fixed.get(key) ?? 0;
    // eslint-disable-next-line no-restricted-syntax -- policy default: a site no direction steers takes the zero draw, the undisturbed path
    else value = this.directedDraw(site, scope) ?? 0;
    if (value < 0 || value >= n) throw new DrawOutOfRange(key, value, n);
    if (value !== 0) this.taken.push({ key, value });
    return value;
  }

  private directedDraw(site: string, scope: string | undefined): number | null {
    let value: number | null = null;
    for (const state of this.directions) {
      const { direction } = state;
      if (direction.kind !== "draw" || !matches(direction.site, site)) continue;
      if (direction.scope !== undefined && direction.scope !== scope) continue;
      state.seen += 1;
      if (direction.nth !== "every" && direction.nth !== state.seen) continue;
      state.taken += 1;
      value ??= direction.value;
    }
    return value;
  }

  /** True with probability `p`; false is benign. `scope` names the work the draw is made for (Direction). */
  chance(site: string, p: number, scope?: string): boolean {
    return this.draw(site, scope, (u) => (u < p ? 1 : 0), 2) === 1;
  }

  /** 0..n-1, uniform; 0 is benign. */
  pick(site: string, n: number, scope?: string): number {
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`Tape.pick(${site}): n must be a positive integer, got ${n}`);
    return this.draw(site, scope, (u) => Math.min(n - 1, Math.floor(u * n)), n);
  }

  /**
   * The fault a direction forces on this seam call, if any: only one `offered` lists, so a forced
   * fault always takes effect on its call. Outside a directed run, null.
   */
  directedFault(seam: SeamKind, label: string, offered: readonly FaultKind[]): FaultKind | null {
    let fault: FaultKind | null = null;
    for (const state of this.directions) {
      const { direction } = state;
      if (direction.kind !== "fault" || direction.seam !== seam || !matches(direction.label, label)) continue;
      state.seen += 1;
      if (direction.nth !== state.seen) continue;
      if (!offered.includes(direction.fault)) {
        state.refused = `its call "${label}" offered only ${offered.join(", ")}`;
        continue;
      }
      state.taken += 1;
      fault ??= direction.fault;
    }
    return fault;
  }

  /** The directions the run never took, each with why: a directed run that misses one did not run its behaviour. */
  untaken(): string[] {
    return this.directions
      .filter((state) => state.taken === 0)
      .map((state) => `${describeDirection(state.direction)}: ${state.refused ?? `${state.seen} matching draw(s) or call(s), none its #${state.direction.nth}`}`);
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
  /** The run mode the decisions were taken in (RunOptions); absent on a file from a one-project run. */
  projects: z.union([z.literal(1), z.literal(2)]).optional(),
  capUsd: z.number().positive().optional(),
  decisions: z.array(DecisionSchema),
});

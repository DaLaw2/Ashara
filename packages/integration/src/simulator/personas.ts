import type { Profile } from "./profile.js";
import type { Tape } from "./tape.js";

/**
 * The stand-ins' sticky personas (ADR-084 decision 4): each model role draws one once per seed, then
 * fires it per occurrence. A per-occurrence draw alone (tape.ts, keyed by site and occurrence)
 * re-rolls every round of a loop independently, so a misbehaviour that is not certain dies out
 * geometrically and a loop that waits for the model to behave always ends: a non-convergent loop
 * cannot show. A persona stays the seed's whole run (FoundationDB's two-stage BUGGIFY), and in the
 * liveness profile it fires on every occurrence from its cycle on (TigerBeetle's liveness mode).
 * Index 0 of every list is honest, so a persona's draw keeps the tape's rule that 0 is benign.
 *
 * Suite review, each answering the review's own prompt and judging only the checks it reads, never
 * production's acceptance rule (a persona that wrote what Z0 accepts would test nothing):
 * - never-satisfied: every review, first and second, names a new undecided item and rejects the same
 *   correct check as outside the vision in new words each time, so the re-sampled second review agrees;
 * - rotating: as never-satisfied, but each round's rejection names the next check task in turn, so
 *   no one check task reaches a per-task bound early;
 * - resurrecting: re-raises, word for word, the first rejection it ever made in the project, on
 *   every later round and every later review task;
 * - flip-flop: rejects a correct check on odd rounds, finds nothing on even rounds;
 * - self-refuting: one contradiction whose two sides are the same check, required and forbidden;
 * - correlated-second: the first review rejects a correct check in words no cited item states, and
 *   the second review, the same model asked again, answers exactly what the first did;
 * - lazy-pass: no problems, whatever the suite holds.
 * Planner: oscillating, every other plan names its tasks in reverse order with their dependencies
 * reversed. Environment classifier: flipping, every other answer is the opposite of what its
 * evidence shows. Check author: sticky-bad, once it writes a bad check for a task it writes the same
 * bad check on every rewrite of that task's checks.
 */
const CATALOG = {
  "suite-review": ["honest", "never-satisfied", "rotating", "resurrecting", "flip-flop", "self-refuting", "correlated-second", "lazy-pass"],
  planner: ["honest", "oscillating"],
  classifier: ["honest", "flipping"],
  "check-author": ["honest", "sticky-bad"],
} as const;

export type PersonaRole = keyof typeof CATALOG;
export type PersonaOf<R extends PersonaRole> = (typeof CATALOG)[R][number];
type Drawn = { readonly [R in PersonaRole]: PersonaOf<R> };

const ROLES = Object.keys(CATALOG).filter((role): role is PersonaRole => Object.hasOwn(CATALOG, role));

/**
 * How often a role carries a persona at all (`on`, once per seed) and how often a carried persona
 * acts at one occurrence (`fire`). Benign carries none. Typical and hostile carry them seldom enough
 * that a seeded soak still reaches the paths its coverage floors count (coverage.ts FLOORS);
 * adversarial carries them often. Liveness carries one on every role and fires it on every
 * occurrence from its cycle on (`permanent`).
 */
interface PersonaRates {
  readonly on: number;
  readonly fire: number;
  readonly permanent: boolean;
}

const RATES: Readonly<Record<Profile, PersonaRates>> = {
  benign: { on: 0, fire: 0, permanent: false },
  typical: { on: 0.05, fire: 0.3, permanent: false },
  hostile: { on: 0.12, fire: 0.5, permanent: false },
  chaos: { on: 0.2, fire: 0.5, permanent: false },
  adversarial: { on: 0.5, fire: 0.8, permanent: false },
  liveness: { on: 1, fire: 1, permanent: true },
};

/** Cycles before a liveness seed's personas turn permanent: drawn per seed from 1 to this many. */
const LIVENESS_ONSET_CYCLES = 6;

/** The tape gave a persona draw a value its list has no entry for. */
class PersonaOutOfRange extends Error {
  constructor(
    readonly role: PersonaRole,
    readonly value: number,
    readonly personas: number,
  ) {
    super(`the tape gives persona.${role} the value ${value}, but its list has ${personas} personas`);
    this.name = "PersonaOutOfRange";
  }
}

/** The personas of one seed's run, drawn once, and when each acts. */
export class Personas {
  private constructor(
    private readonly drawn: Drawn,
    private readonly rates: PersonaRates,
    /** The cycle from which a permanent persona fires on every occurrence; null outside liveness. */
    private readonly onset: number | null,
    private readonly tape: Tape,
    private readonly cycle: () => number,
  ) {}

  /** Draws each role's persona once (`persona.<role>.on`, then `persona.<role>`), and a liveness seed's onset cycle. */
  static draw(profile: Profile, tape: Tape, cycle: () => number): Personas {
    const rates = RATES[profile];
    const pick = <T extends string>(role: PersonaRole, list: readonly [T, ...T[]]): T => {
      // A certain rate draws nothing: a directed tape forces only the persona itself.
      const on = rates.on >= 1 || tape.chance(`persona.${role}.on`, rates.on);
      if (!on) return list[0];
      const at = tape.pick(`persona.${role}`, list.length);
      const persona = list[at];
      if (persona === undefined) throw new PersonaOutOfRange(role, at, list.length);
      return persona;
    };
    const drawn: Drawn = {
      "suite-review": pick("suite-review", CATALOG["suite-review"]),
      planner: pick("planner", CATALOG.planner),
      classifier: pick("classifier", CATALOG.classifier),
      "check-author": pick("check-author", CATALOG["check-author"]),
    };
    const onset = rates.permanent ? 1 + tape.pick("persona.onset-cycle", LIVENESS_ONSET_CYCLES) : null;
    return new Personas(drawn, rates, onset, tape, cycle);
  }

  of<R extends PersonaRole>(role: R): PersonaOf<R> {
    return this.drawn[role];
  }

  /**
   * Whether `role`'s persona acts at this occurrence: never for an honest one; from the onset cycle
   * on for a permanent one; otherwise drawn (`persona.<role>.fires`) at the profile's rate.
   */
  fires(role: PersonaRole): boolean {
    if (this.drawn[role] === "honest") return false;
    if (this.onset !== null) return this.cycle() >= this.onset;
    return this.tape.chance(`persona.${role}.fires`, this.rates.fire);
  }

  /** The trace's line for them. */
  describe(): string {
    return `personas ${ROLES.map((role) => `${role}=${this.drawn[role]}`).join(" ")}${this.onset === null ? "" : ` from cycle ${this.onset}`}`;
  }
}

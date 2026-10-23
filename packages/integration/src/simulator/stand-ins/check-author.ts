import { sql } from "drizzle-orm";
import { z } from "zod";
import { behaviourPath, isInterfaceTaskTitle, isRestateTaskTitle, restatedBehaviour, taskOfTitle } from "../product.js";
import type { CheckSpec, SimTask } from "../product.js";
import type { StandInContext } from "./context.js";
import { namesBehaviour } from "./context.js";
import { StandInUnanswerable } from "./responses.js";
import { finished } from "./tool-steps.js";
import type { ToolStep } from "./tool-steps.js";

/** The bad checks a sticky-bad check author writes again on every rewrite. */
const STICKY_KINDS = ["contradictory", "wrong", "out_of_vision"] as const;
type StickyKind = (typeof STICKY_KINDS)[number];

/** `list[at]`, where the tape drew `at` from `list.length`. */
function nthOf<T>(list: readonly T[], at: number): T {
  const value = list[at];
  if (value === undefined)
    throw new StandInUnanswerable("persona", `the tape drew ${at} from a list of ${list.length}`);
  return value;
}

/** The check author's turns, honest or as the sticky-bad persona, as the stand-in scripts them. */
export class CheckAuthorStandIn {
  /** The checked tasks a sticky-bad check author has written a bad check for: every rewrite writes it again. */
  private readonly stickyBad = new Set<string>();
  /** The bad check a sticky-bad check author writes, drawn once per run. */
  private stickyKind: StickyKind | null = null;

  constructor(private readonly context: StandInContext) {}

  /**
   * A check task's turns. Each check names the cited items it decides: a behaviour's check
   * decides the cited guarantee that names it, and every cited item no such check decides gets a check
   * of its own, so the set decides every item its task cites, as an honest author writes it.
   */
  async checkWork(
    checksFor: string | undefined,
    sources: ReadonlyArray<{ readonly id: string; readonly text: string }>,
  ): Promise<ToolStep[]> {
    const { tape, rates, universe } = this.context;
    const cited = sources.map((source) => source.id);
    if (checksFor === undefined) throw new StandInUnanswerable("agent-runner", "a check task names no task it checks");
    const [firstCited] = cited;
    if (firstCited === undefined)
      throw new StandInUnanswerable("agent-runner", `the check task for ${checksFor} cites no vision item`);
    const checkedTitle = await this.titleOf(checksFor);
    if (isInterfaceTaskTitle(checkedTitle)) {
      const path = `checks/${checksFor}/interface.json`;
      const spec: CheckSpec = { kind: "interface", requires: [], forbids: [], harness: [] };
      return [
        ["write_file", { path, content: `${JSON.stringify(spec)}\n` }],
        ["define_check", { name: "interface", command: `sim check ${path}`, decides: cited }],
        finished("Defined 1 check(s)."),
      ];
    }
    if (isRestateTaskTitle(checkedTitle)) {
      const path = `checks/${checksFor}/restated.json`;
      // What the corrected contract states either asks for behaviour of its own, which the product on
      // the foundation lacks, or already holds there as the delivered product stands, so the check
      // requires nothing that product lacks.
      const holds = tape.chance("agent.check.restate-holds", 0.5, "checks");
      const requires = holds ? [] : [restatedBehaviour(checksFor)];
      const spec: CheckSpec = { kind: "correct", requires, forbids: [], harness: [] };
      return [
        ["write_file", { path, content: `${JSON.stringify(spec)}\n` }],
        ["define_check", { name: "restated", command: `sim check ${path}`, decides: cited }],
        finished("Defined 1 check(s)."),
      ];
    }
    const checked = taskOfTitle(universe, checkedTitle);
    if (checked === null)
      throw new StandInUnanswerable(
        "agent-runner",
        `check task for ${checksFor}: its title carries no simulator marker`,
      );
    const decidedBy = (b: string): readonly string[] => {
      const naming = sources.find((source) => namesBehaviour(source.text, b));
      return naming === undefined ? [firstCited] : [naming.id];
    };
    const checks: Array<{ readonly name: string; readonly spec: CheckSpec; readonly decides: readonly string[] }> =
      checked.behaviours.map((b) => ({
        name: `has-${b}`,
        spec: { kind: "correct", requires: [b], forbids: [], harness: [] },
        decides: decidedBy(b),
      }));
    for (const id of cited.filter((each) => !checks.some((check) => check.decides.includes(each)))) {
      checks.push({
        name: `holds-${id}`,
        spec: { kind: "correct", requires: [...checked.behaviours], forbids: [], harness: [] },
        decides: [id],
      });
    }
    const other = universe.tasks.find((t) => t.ref !== checked.ref);
    const extra = (name: string, spec: CheckSpec): void => void checks.push({ name, spec, decides: [firstCited] });
    if (tape.chance("agent.check.wrong", rates.wrongCheck, "checks"))
      extra("wrong", { kind: "wrong", requires: ["b-never"], forbids: [], harness: [] });
    if (other !== undefined && tape.chance("agent.check.contradictory", rates.contradictoryCheck, "checks")) {
      extra("contradicts", { kind: "contradictory", requires: [], forbids: [...other.behaviours], harness: [] });
    }
    if (tape.chance("agent.check.vacuous", rates.vacuousCheck, "checks"))
      extra("vacuous", { kind: "vacuous", requires: [], forbids: [], harness: [] });
    if (tape.chance("agent.check.out-of-vision", rates.outOfVisionCheck, "checks")) {
      extra("extra", { kind: "out_of_vision", requires: [universe.outOfVision], forbids: [], harness: [] });
    }
    if (tape.chance("agent.check.flaky", rates.flakyCheck, "checks"))
      extra("flaky", { kind: "flaky", requires: [...checked.behaviours], forbids: [], harness: [] });
    if (tape.chance("agent.check.unrunnable", rates.unrunnableCheck, "checks")) {
      extra("unrunnable", {
        kind: tape.pick("agent.check.unrunnable-kind", 2, "checks") === 0 ? "unrunnable" : "slow",
        requires: [],
        forbids: [],
        harness: [],
      });
    }
    if (tape.chance("agent.check.harness", rates.flakyCheck, "checks")) {
      extra("harness", {
        kind: "correct",
        requires: [...checked.behaviours],
        forbids: [],
        harness: [{ path: `product/harness/${checked.ref}`, content: "harness\n" }],
      });
    }
    const sticky = this.stickyBadCheck(checksFor, other);
    if (sticky !== null) extra(`sticky-${sticky.kind}`, sticky);
    const allGuard = tape.chance("agent.check.all-guard", rates.allGuardSet, "checks");
    const kept = allGuard
      ? checks.map((check) => ({ ...check, spec: { ...check.spec, kind: "vacuous" as const } }))
      : checks;
    const steps: ToolStep[] = [];
    for (const check of kept) {
      // The checks directory the brief names (checkAreaOf): the checked task's id, not the simulator's ref.
      const path = `checks/${checksFor}/${check.name}.json`;
      steps.push(["write_file", { path, content: `${JSON.stringify(check.spec)}\n` }]);
      steps.push(["define_check", { name: check.name, command: `sim check ${path}`, decides: check.decides }]);
    }
    // The author also writes the product it checks, in its own workspace.
    if (tape.chance("agent.check.writes-product", rates.authorWritesProduct, "checks")) {
      for (const b of checked.behaviours)
        steps.push(["write_file", { path: behaviourPath(b), content: `${b} by the check author\n` }]);
    }
    steps.push(finished(`Defined ${kept.length} check(s).`));
    return steps;
  }

  /**
   * The bad check a sticky-bad check author writes for `checksFor`: none until its persona first
   * fires on that task's checks, then the same one on every rewrite of them. A contradiction needs
   * another task to forbid the behaviours of; without one the author writes a wrong check.
   */
  private stickyBadCheck(checksFor: string, other: SimTask | undefined): CheckSpec | null {
    const { personas, tape, universe, onModelCall } = this.context;
    if (personas.of("check-author") !== "sticky-bad") return null;
    if (!this.stickyBad.has(checksFor)) {
      if (!personas.fires("check-author")) return null;
      this.stickyBad.add(checksFor);
    }
    this.stickyKind ??= nthOf(STICKY_KINDS, tape.pick("persona.check-author.kind", STICKY_KINDS.length, "checks"));
    const kind: StickyKind = this.stickyKind === "contradictory" && other === undefined ? "wrong" : this.stickyKind;
    onModelCall({ site: "agent-runner", action: `persona sticky-bad: writes a ${kind} check again` });
    switch (kind) {
      case "contradictory":
        /* eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, the contradictory
           kind is only chosen with another task (above); no oracle reads it */
        return { kind, requires: [], forbids: [...(other?.behaviours ?? [])], harness: [] };
      case "wrong":
        return { kind, requires: ["b-never"], forbids: [], harness: [] };
      case "out_of_vision":
        return { kind, requires: [universe.outOfVision], forbids: [], harness: [] };
    }
  }

  private async titleOf(id: string): Promise<string> {
    const result = await this.context.observer.execute(sql`SELECT title FROM work_items WHERE id = ${id}`);
    const [row] = z.array(z.object({ title: z.string() })).parse(result.rows);
    if (row === undefined) throw new StandInUnanswerable("agent-runner", `work item ${id} is not on record`);
    return row.title;
  }
}

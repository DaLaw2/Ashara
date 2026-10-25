import { BaseSequencer, type TestSpecification } from "vitest/node";
import { WHOLE_TREE_PROJECT } from "./test-run-load.js";

/**
 * vitest's own order, except that within a sequence group the whole-tree project's file starts
 * first. vitest orders the projects of a group by name, which puts that file, the heaviest of the
 * suite (it builds the TS program over the whole checkout), last: it then runs alone at the end
 * while every other worker idles. Started first, it runs beside the rest.
 * @testseam vitest.config.mts sets it as the run's sequencer; vitest-config.test.ts checks the order
 */
export class WholeTreeFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const rank = (spec: TestSpecification): number => (spec.project.name === WHOLE_TREE_PROJECT ? 0 : 1);
    // Array.prototype.sort is stable: every other file keeps vitest's order.
    return sorted.sort((a, b) => a.project.config.sequence.groupOrder - b.project.config.sequence.groupOrder || rank(a) - rank(b));
  }
}

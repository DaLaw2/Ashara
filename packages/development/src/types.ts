export interface TaskSpec {
  readonly goal: string;
  readonly endState: string;
  readonly scope: string;
  readonly deliverables: string[];
  readonly checks: string[];
}

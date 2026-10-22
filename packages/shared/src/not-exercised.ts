/**
 * A dependency a test supplied only to satisfy its type was called: the test reached code it did not mean to.
 * @testseam a test tells an unexpected call from its own failure by it; notExercised throws it
 */
export class NotExercised extends Error {
  constructor(readonly label: string) {
    super(`${label}: not exercised`);
    this.name = "NotExercised";
  }
}

/** A member a test never expects to be called: calling it throws NotExercised naming `label`. */
export function notExercised(label: string): () => never {
  return () => {
    throw new NotExercised(label);
  };
}

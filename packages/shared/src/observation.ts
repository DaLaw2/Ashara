import { z } from "zod";

export const EndpointProbeSchema = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  status: z.number().int().nullable(),
  detail: z.string(),
}).strict();
export type EndpointProbe = z.infer<typeof EndpointProbeSchema>;

/**
 * Why no observation could be ATTEMPTED. Every member describes a limit of the
 * OBSERVER, never a defect in the product — that distinction is the whole point
 * of the `not-observable` variant.
 *
 *  - `no-declared-surface`  — the project declares nothing this observer knows how
 *    to check. Ashara probes declared HTTP endpoints; a CLI, a library, a kernel
 *    module, or an HTTP server whose routes cannot be read statically all land here.
 *  - `no-launch-command`    — nothing the project declared says how to start it.
 *  - `toolchain-unprepared` — the tree could not be made runnable (install/codegen),
 *    which is indistinguishable from a host or network fault and so is never
 *    charged to the product.
 *  - `launch-failed`        — the declared command could not be executed at all
 *    (spawn error), i.e. the runtime it names is absent from this host.
 */
const NotObservableCauseSchema = z.enum([
  "no-declared-surface",
  "no-launch-command",
  "toolchain-unprepared",
  "launch-failed",
]);

/**
 * What one attempt to observe a running product produced. THREE states, because
 * two of them were previously collapsed onto `booted: false` and read downstream
 * as evidence of a broken product (Discipline A):
 *
 *  - `not-observable` — no observation was possible. Carries NO verdict about the
 *    product. Acceptance must route this to `unverified`, never to a gap.
 *  - `boot-failed`    — the product was launched as it declared and did not reach
 *    the state it declared. This IS evidence, and the only variant that may
 *    produce a gap.
 *  - `booted`         — the product ran and every endpoint it declares was probed.
 *    `endpoints` is non-empty by construction so a "booted, checked nothing"
 *    observation — the identity element that always reads as "fine" — cannot be
 *    built at all.
 */
export const ProductObservationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("not-observable"),
    cause: NotObservableCauseSchema,
    detail: z.string().min(1).max(4000),
  }).strict(),
  z.object({
    kind: z.literal("boot-failed"),
    detail: z.string().min(1).max(4000),
  }).strict(),
  z.object({
    kind: z.literal("booted"),
    port: z.number().int().positive(),
    endpoints: z.array(EndpointProbeSchema).nonempty(),
    bootOutput: z.string().max(4000),
  }).strict(),
]);
export type ProductObservation = z.infer<typeof ProductObservationSchema>;

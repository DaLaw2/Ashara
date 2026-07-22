import { z } from "zod";

export const EndpointProbeSchema = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  status: z.number().int().nullable(),
  detail: z.string(),
}).strict();
export type EndpointProbe = z.infer<typeof EndpointProbeSchema>;

export const ProductObservationSchema = z.object({
  booted: z.boolean(),
  port: z.number().int().positive().nullable(),
  endpoints: z.array(EndpointProbeSchema),
  bootOutput: z.string().max(4000),
}).strict();
export type ProductObservation = z.infer<typeof ProductObservationSchema>;

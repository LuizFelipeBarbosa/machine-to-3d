import { z } from 'zod';
import { ViewSchema } from './machine';

export const StepLocationSchema = z.enum(['instrument', 'software', 'logbook']);

export const StepLinkSchema = z.object({
  /** Slug of another procedure on the same machine. */
  procedureSlug: z.string(),
  /** Stable step id, never a step index. */
  stepId: z.string().optional(),
  label: z.string(),
}).strict();

export const StepMediaSchema = z.object({
  fileId: z.string(),
  alt: z.string(),
}).strict();

export const StepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  where: StepLocationSchema,
  body: z.string(),
  parts: z.array(z.string()),
  view: ViewSchema,
  /** A step's `state` is an ABSOLUTE SET, never a toggle. `{ lift: true }` means
   * lift is on from this step onward whatever it was before; repeating it is a no-op.
   * Only variables that change need to be listed. */
  state: z.record(z.string(), z.boolean()).optional(),
  caution: z.string().optional(),
  check: z.string().optional(),
  media: StepMediaSchema.optional(),
  link: StepLinkSchema.optional(),
}).strict();

export const ProcedureContentSchema = z.object({
  formatVersion: z.literal(1),
  title: z.string().min(1),
  summary: z.string(),
  minutes: z.number().int().positive(),
  start: z.record(z.string(), z.boolean()),
  steps: z.array(StepSchema),
}).strict();

export type StepLocation = z.infer<typeof StepLocationSchema>;
export type StepLink = z.infer<typeof StepLinkSchema>;
export type StepMedia = z.infer<typeof StepMediaSchema>;
export type Step = z.infer<typeof StepSchema>;
export type ProcedureContent = z.infer<typeof ProcedureContentSchema>;

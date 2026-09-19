import { zodToConvex } from 'convex-helpers/server/zod4';
import { v } from 'convex/values';
import { MachineDefinitionSchema } from '../../shared/machine';
import { ProcedureContentSchema } from '../../shared/procedure';

export const roleValidator = v.union(
  v.literal('trainee'),
  v.literal('author'),
  v.literal('approver'),
  v.literal('admin'),
);

export type Role = 'trainee' | 'author' | 'approver' | 'admin';

export const versionStatusValidator = v.union(
  v.literal('draft'),
  v.literal('approved'),
  v.literal('retired'),
);

// The bridge preserves structure and literals but broadens tuples to arrays and
// omits refinements (including duplicate names, lengths, and numeric bounds).
// Mutations that write this content must parse it with the shared Zod schemas.
export const machineDefinitionValidator = zodToConvex(MachineDefinitionSchema);
export const procedureContentValidator = zodToConvex(ProcedureContentSchema);

export const checkpointValidator = v.object({
  stepId: v.string(),
  at: v.number(),
});

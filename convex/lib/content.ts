import { ConvexError } from 'convex/values';
import { ZodError } from 'zod';
import { MachineDefinitionSchema } from '../../shared/machine';
import type { MachineDefinition } from '../../shared/machine';
import { ProcedureContentSchema } from '../../shared/procedure';
import type { ProcedureContent } from '../../shared/procedure';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

function firstIssue(error: ZodError): string {
  const issue = error.issues[0];
  return `${issue.path.join('.') || '(root)'}: ${issue.message}`;
}

export function parseContent(raw: unknown): ProcedureContent {
  try {
    return ProcedureContentSchema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConvexError(`Invalid procedure content: ${firstIssue(error)}`);
    }
    throw error;
  }
}

export function parseDefinition(raw: unknown): MachineDefinition {
  try {
    return MachineDefinitionSchema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConvexError(`Invalid machine definition: ${firstIssue(error)}`);
    }
    throw error;
  }
}

export async function requireMachine(ctx: QueryCtx, machineId: Id<'machines'>) {
  const machine = await ctx.db.get(machineId);
  if (machine === null) {
    throw new ConvexError('Machine not found');
  }
  return machine;
}

export async function requireMachineVersion(
  ctx: QueryCtx,
  versionId: Id<'machineVersions'> | undefined,
) {
  const version = versionId === undefined ? null : await ctx.db.get(versionId);
  if (version === null) {
    throw new ConvexError('Machine version not found');
  }
  return version;
}

export async function requireProcedure(ctx: QueryCtx, procedureId: Id<'procedures'>) {
  const procedure = await ctx.db.get(procedureId);
  if (procedure === null) {
    throw new ConvexError('Procedure not found');
  }
  return procedure;
}

export async function requireVersion(ctx: QueryCtx, versionId: Id<'procedureVersions'>) {
  const version = await ctx.db.get(versionId);
  if (version === null) {
    throw new ConvexError('Procedure version not found');
  }
  return version;
}

export async function getDraft(ctx: QueryCtx, procedureId: Id<'procedures'>) {
  return ctx.db
    .query('procedureVersions')
    .withIndex('by_procedure_status', (q) =>
      q.eq('procedureId', procedureId).eq('status', 'draft'),
    )
    .unique();
}

export async function getLatestVersion(ctx: QueryCtx, procedureId: Id<'procedures'>) {
  return ctx.db
    .query('procedureVersions')
    .withIndex('by_procedure', (q) => q.eq('procedureId', procedureId))
    .order('desc')
    .first();
}

export async function getApprovedVersion(ctx: QueryCtx, procedure: Doc<'procedures'>) {
  if (procedure.approvedVersionId === undefined) {
    return null;
  }
  const version = await ctx.db.get(procedure.approvedVersionId);
  if (version?.status !== 'approved' || version.procedureId !== procedure._id) {
    return null;
  }
  return version;
}

export async function linkTargetsForMachine(
  ctx: QueryCtx,
  machineId: Id<'machines'>,
): Promise<Record<string, string[]>> {
  const procedures = await ctx.db
    .query('procedures')
    .withIndex('by_machine', (q) => q.eq('machineId', machineId))
    .collect();
  const entries: [string, string[]][] = [];
  for (const procedure of procedures) {
    const approved = await getApprovedVersion(ctx, procedure);
    if (approved !== null) {
      entries.push([procedure.slug, parseContent(approved.content).steps.map((step) => step.id)]);
    }
  }
  return Object.fromEntries(entries);
}

export function emptyProcedureContent(
  title: string,
  definition: MachineDefinition,
): ProcedureContent {
  return {
    formatVersion: 1,
    title,
    summary: '',
    minutes: 10,
    start: Object.fromEntries(definition.stateVars.map((stateVar) => [stateVar.name, false])),
    steps: [{
      id: 'step-1',
      title: 'First step',
      where: 'instrument',
      body: '',
      parts: [],
      view: definition.presetViews[0]?.view ?? { pos: [0, 0, 10], target: [0, 0, 0] },
    }],
  };
}

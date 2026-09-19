import { ConvexError } from 'convex/values';
import { ZodError } from 'zod';
import { MachineDefinitionSchema } from '../../shared/machine';
import type { MachineDefinition } from '../../shared/machine';
import { ProcedureContentSchema } from '../../shared/procedure';
import type { ProcedureContent } from '../../shared/procedure';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

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

export async function mediaUrlsForContent(
  ctx: QueryCtx,
  contents: ProcedureContent[],
): Promise<Record<string, string>> {
  const fileIds = new Set<string>();
  for (const content of contents) {
    if (content.video) fileIds.add(content.video.fileId);
    for (const step of content.steps) {
      if (step.media) fileIds.add(step.media.fileId);
    }
  }
  const entries: [string, string][] = [];
  for (const fileId of fileIds) {
    const storageId = ctx.db.system.normalizeId('_storage', fileId);
    if (storageId === null) continue;
    const url = await ctx.storage.getUrl(storageId);
    if (url !== null) entries.push([fileId, url]);
  }
  return Object.fromEntries(entries);
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

export async function publishMachineVersion(
  ctx: MutationCtx,
  { slug, name, kind, modelFileId, definition: rawDefinition, publish = true, sourceFileId }: {
    slug: string;
    name: string;
    kind: string;
    modelFileId: Id<'_storage'>;
    definition: unknown;
    publish?: boolean;
    sourceFileId?: Id<'_storage'>;
  },
) {
  const definition = parseDefinition(rawDefinition);
  const machine = await ctx.db
    .query('machines')
    .withIndex('by_slug', (q) => q.eq('slug', slug))
    .unique();
  const machineId = machine === null
    ? await ctx.db.insert('machines', { slug, name, kind })
    : machine._id;
  const latest = await ctx.db
    .query('machineVersions')
    .withIndex('by_machine', (q) => q.eq('machineId', machineId))
    .order('desc')
    .first();
  const version = (latest?.version ?? 0) + 1;
  const machineVersionId = await ctx.db.insert('machineVersions', {
    machineId,
    version,
    status: publish ? 'published' : 'draft',
    modelFileId,
    ...(sourceFileId === undefined ? {} : { sourceFileId }),
    definition,
  });
  if (publish) {
    await ctx.db.patch(machineId, { name, kind, currentVersionId: machineVersionId });
  }
  return { machineId, machineVersionId, version };
}

export async function publishDraftMachineVersion(
  ctx: MutationCtx,
  machineVersionId: Id<'machineVersions'>,
) {
  const version = await requireMachineVersion(ctx, machineVersionId);
  if (version.status !== 'draft') {
    throw new ConvexError('Only draft machine versions can be published');
  }
  const machine = await requireMachine(ctx, version.machineId);
  if (machine.currentVersionId !== undefined) {
    const currentVersion = await requireMachineVersion(ctx, machine.currentVersionId);
    if (currentVersion.version >= version.version) {
      throw new ConvexError('Machine version superseded');
    }
  }
  await ctx.db.patch(version._id, { status: 'published' });
  await ctx.db.patch(machine._id, { currentVersionId: version._id });
}

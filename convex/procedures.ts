import { ConvexError, v } from 'convex/values';
import { validateProcedure } from '../shared/validateProcedure';
import { mutation, query } from './_generated/server';
import { requireRole, requireUser } from './lib/authz';
import {
  emptyProcedureContent,
  getApprovedVersion,
  getDraft,
  getLatestVersion,
  linkTargetsForMachine,
  parseContent,
  parseDefinition,
  requireMachine,
  requireMachineVersion,
  requireProcedure,
  requireVersion,
} from './lib/content';
import {
  machineDefinitionValidator,
  procedureContentValidator,
  versionStatusValidator,
} from './lib/validators';

const linkTargetsValidator = v.record(v.string(), v.array(v.string()));

export const getForPlay = query({
  args: { machineSlug: v.string(), procedureSlug: v.string() },
  returns: v.union(v.object({
    procedureId: v.id('procedures'),
    versionId: v.id('procedureVersions'),
    version: v.number(),
    machineVersionId: v.id('machineVersions'),
    content: procedureContentValidator,
    modelUrl: v.union(v.string(), v.null()),
    definition: machineDefinitionValidator,
    linkTargets: linkTargetsValidator,
  }), v.null()),
  handler: async (ctx, { machineSlug, procedureSlug }) => {
    await requireUser(ctx);
    const machine = await ctx.db
      .query('machines')
      .withIndex('by_slug', (q) => q.eq('slug', machineSlug))
      .unique();
    if (machine === null) {
      return null;
    }
    const procedure = await ctx.db
      .query('procedures')
      .withIndex('by_machine_slug', (q) =>
        q.eq('machineId', machine._id).eq('slug', procedureSlug),
      )
      .unique();
    if (procedure === null) {
      return null;
    }
    const version = await getApprovedVersion(ctx, procedure);
    if (version === null) {
      return null;
    }
    const machineVersion = await requireMachineVersion(ctx, version.machineVersionId);
    return {
      procedureId: procedure._id,
      versionId: version._id,
      version: version.version,
      machineVersionId: machineVersion._id,
      content: parseContent(version.content),
      modelUrl: await ctx.storage.getUrl(machineVersion.modelFileId),
      definition: parseDefinition(machineVersion.definition),
      linkTargets: await linkTargetsForMachine(ctx, machine._id),
    };
  },
});

export const getVersion = query({
  args: { versionId: v.id('procedureVersions') },
  returns: v.object({
    _id: v.id('procedureVersions'),
    procedureId: v.id('procedures'),
    version: v.number(),
    status: versionStatusValidator,
    machineVersionId: v.id('machineVersions'),
    content: procedureContentValidator,
    changeNote: v.optional(v.string()),
    approvedAt: v.optional(v.number()),
    createdBy: v.optional(v.id('users')),
    modelUrl: v.union(v.string(), v.null()),
    definition: machineDefinitionValidator,
    linkTargets: linkTargetsValidator,
    machineSlug: v.string(),
    procedureSlug: v.string(),
  }),
  handler: async (ctx, { versionId }) => {
    await requireRole(ctx, 'author');
    const version = await requireVersion(ctx, versionId);
    const procedure = await requireProcedure(ctx, version.procedureId);
    const machine = await requireMachine(ctx, procedure.machineId);
    const machineVersion = await requireMachineVersion(ctx, version.machineVersionId);
    return {
      _id: version._id,
      procedureId: procedure._id,
      version: version.version,
      status: version.status,
      machineVersionId: machineVersion._id,
      content: parseContent(version.content),
      changeNote: version.changeNote,
      approvedAt: version.approvedAt,
      createdBy: version.createdBy,
      modelUrl: await ctx.storage.getUrl(machineVersion.modelFileId),
      definition: parseDefinition(machineVersion.definition),
      linkTargets: await linkTargetsForMachine(ctx, machine._id),
      machineSlug: machine.slug,
      procedureSlug: procedure.slug,
    };
  },
});

export const listVersions = query({
  args: { procedureId: v.id('procedures') },
  returns: v.array(v.object({
    _id: v.id('procedureVersions'),
    version: v.number(),
    status: versionStatusValidator,
    _creationTime: v.number(),
    approvedAt: v.optional(v.number()),
    changeNote: v.optional(v.string()),
    copiedFromVersionId: v.optional(v.id('procedureVersions')),
  })),
  handler: async (ctx, { procedureId }) => {
    await requireRole(ctx, 'author');
    const versions = await ctx.db
      .query('procedureVersions')
      .withIndex('by_procedure', (q) => q.eq('procedureId', procedureId))
      .order('desc')
      .collect();
    return versions.map((version) => ({
      _id: version._id,
      version: version.version,
      status: version.status,
      _creationTime: version._creationTime,
      approvedAt: version.approvedAt,
      changeNote: version.changeNote,
      copiedFromVersionId: version.copiedFromVersionId,
    }));
  },
});

export const create = mutation({
  args: { machineId: v.id('machines'), slug: v.string(), title: v.string() },
  returns: v.object({ procedureId: v.id('procedures'), versionId: v.id('procedureVersions') }),
  handler: async (ctx, { machineId, slug, title }) => {
    const user = await requireRole(ctx, 'author');
    if (!/^[a-z0-9-]+$/.test(slug)) {
      throw new ConvexError('Invalid procedure slug');
    }
    const machine = await requireMachine(ctx, machineId);
    const existing = await ctx.db
      .query('procedures')
      .withIndex('by_machine_slug', (q) => q.eq('machineId', machineId).eq('slug', slug))
      .unique();
    if (existing !== null) {
      throw new ConvexError('Slug already used');
    }
    const machineVersion = await requireMachineVersion(ctx, machine.currentVersionId);
    const definition = parseDefinition(machineVersion.definition);
    const content = parseContent(emptyProcedureContent(title, definition));
    const procedureId = await ctx.db.insert('procedures', { machineId, slug });
    const versionId = await ctx.db.insert('procedureVersions', {
      procedureId,
      version: 1,
      status: 'draft',
      machineVersionId: machineVersion._id,
      content,
      createdBy: user._id,
    });
    return { procedureId, versionId };
  },
});

export const createDraft = mutation({
  args: {
    procedureId: v.id('procedures'),
    fromVersionId: v.optional(v.id('procedureVersions')),
  },
  returns: v.id('procedureVersions'),
  handler: async (ctx, { procedureId, fromVersionId }) => {
    const user = await requireRole(ctx, 'author');
    const procedure = await requireProcedure(ctx, procedureId);
    if (await getDraft(ctx, procedureId) !== null) {
      throw new ConvexError('A draft already exists');
    }
    const latest = await getLatestVersion(ctx, procedureId);
    const source = fromVersionId === undefined
      ? await getApprovedVersion(ctx, procedure) ?? latest
      : await requireVersion(ctx, fromVersionId);
    if (source === null) {
      throw new ConvexError('No procedure version to copy');
    }
    if (source.procedureId !== procedureId) {
      throw new ConvexError('Source version belongs to another procedure');
    }
    const machine = await requireMachine(ctx, procedure.machineId);
    const machineVersion = await requireMachineVersion(ctx, machine.currentVersionId);
    return ctx.db.insert('procedureVersions', {
      procedureId,
      version: (latest?.version ?? 0) + 1,
      status: 'draft',
      machineVersionId: machineVersion._id,
      content: parseContent(source.content),
      copiedFromVersionId: source._id,
      createdBy: user._id,
    });
  },
});

export const saveDraft = mutation({
  args: { versionId: v.id('procedureVersions'), content: procedureContentValidator },
  returns: v.null(),
  handler: async (ctx, { versionId, content }) => {
    await requireRole(ctx, 'author');
    const version = await requireVersion(ctx, versionId);
    if (version.status !== 'draft') {
      throw new ConvexError('Only drafts can be edited');
    }
    await ctx.db.patch(versionId, { content: parseContent(content) });
    return null;
  },
});

export const discardDraft = mutation({
  args: { versionId: v.id('procedureVersions') },
  returns: v.null(),
  handler: async (ctx, { versionId }) => {
    await requireRole(ctx, 'author');
    const version = await requireVersion(ctx, versionId);
    if (version.status !== 'draft') {
      throw new ConvexError('Only drafts can be discarded');
    }
    await ctx.db.delete(versionId);
    if (await getLatestVersion(ctx, version.procedureId) === null) {
      await ctx.db.delete(version.procedureId);
    }
    return null;
  },
});

export const approve = mutation({
  args: { versionId: v.id('procedureVersions'), changeNote: v.string() },
  returns: v.null(),
  handler: async (ctx, { versionId, changeNote }) => {
    const user = await requireRole(ctx, 'approver');
    const version = await requireVersion(ctx, versionId);
    if (version.status !== 'draft') {
      throw new ConvexError('Only drafts can be approved');
    }
    const procedure = await requireProcedure(ctx, version.procedureId);
    const machineVersion = await requireMachineVersion(ctx, version.machineVersionId);
    const content = parseContent(version.content);
    const definition = parseDefinition(machineVersion.definition);
    const linkTargets = await linkTargetsForMachine(ctx, procedure.machineId);
    linkTargets[procedure.slug] = content.steps.map((step) => step.id);
    const issues = validateProcedure(content, definition, linkTargets);
    if (issues.length > 0) {
      const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
      throw new ConvexError(`Invalid procedure references:\n${details}`);
    }

    const previous = await getApprovedVersion(ctx, procedure);
    if (previous !== null) {
      await ctx.db.patch(previous._id, { status: 'retired' });
    }
    await ctx.db.patch(versionId, {
      status: 'approved',
      approvedBy: user._id,
      approvedAt: Date.now(),
      changeNote,
    });
    await ctx.db.patch(procedure._id, { approvedVersionId: versionId });
    return null;
  },
});

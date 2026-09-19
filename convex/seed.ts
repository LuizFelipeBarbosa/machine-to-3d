import { ConvexError, v } from 'convex/values';
import { validateProcedure } from '../shared/validateProcedure';
import { internalMutation, internalQuery } from './_generated/server';
import {
  parseContent,
  parseDefinition,
  publishMachineVersion,
  requireMachineVersion,
} from './lib/content';
import { machineDefinitionValidator, procedureContentValidator } from './lib/validators';

export const uploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

export const machineExists = internalQuery({
  args: { slug: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { slug }) => {
    const machine = await ctx.db
      .query('machines')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique();
    return machine !== null;
  },
});

export const upsertMachine = internalMutation({
  args: {
    slug: v.string(),
    name: v.string(),
    kind: v.string(),
    modelFileId: v.id('_storage'),
    definition: machineDefinitionValidator,
  },
  returns: v.object({
    machineId: v.id('machines'),
    machineVersionId: v.optional(v.id('machineVersions')),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const machine = await ctx.db
      .query('machines')
      .withIndex('by_slug', (q) => q.eq('slug', args.slug))
      .unique();
    if (machine !== null) {
      return {
        machineId: machine._id,
        machineVersionId: machine.currentVersionId,
        created: false,
      };
    }
    const { machineId, machineVersionId } = await publishMachineVersion(ctx, args);
    return { machineId, machineVersionId, created: true };
  },
});

export const upsertProcedure = internalMutation({
  args: {
    machineSlug: v.string(),
    slug: v.string(),
    content: procedureContentValidator,
    linkTargets: v.record(v.string(), v.array(v.string())),
  },
  returns: v.union(
    v.object({ created: v.literal(false) }),
    v.object({ created: v.literal(true), versionId: v.id('procedureVersions') }),
  ),
  handler: async (ctx, { machineSlug, slug, content: rawContent, linkTargets }) => {
    const machine = await ctx.db
      .query('machines')
      .withIndex('by_slug', (q) => q.eq('slug', machineSlug))
      .unique();
    if (machine === null) {
      throw new ConvexError('Machine not found');
    }
    const existing = await ctx.db
      .query('procedures')
      .withIndex('by_machine_slug', (q) => q.eq('machineId', machine._id).eq('slug', slug))
      .unique();
    if (existing !== null) {
      return { created: false as const };
    }
    const machineVersion = await requireMachineVersion(ctx, machine.currentVersionId);
    const content = parseContent(rawContent);
    const definition = parseDefinition(machineVersion.definition);
    const issues = validateProcedure(content, definition, linkTargets);
    if (issues.length > 0) {
      const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
      throw new ConvexError(`Invalid procedure references:\n${details}`);
    }
    const procedureId = await ctx.db.insert('procedures', { machineId: machine._id, slug });
    const versionId = await ctx.db.insert('procedureVersions', {
      procedureId,
      version: 1,
      status: 'approved',
      machineVersionId: machineVersion._id,
      content,
      approvedAt: Date.now(),
      changeNote: 'Seeded',
    });
    await ctx.db.patch(procedureId, { approvedVersionId: versionId });
    return { created: true as const, versionId };
  },
});

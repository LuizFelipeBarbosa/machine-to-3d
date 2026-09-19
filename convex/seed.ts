import { ConvexError, v } from 'convex/values';
import { validateProcedure } from '../shared/validateProcedure';
import { internalMutation, internalQuery } from './_generated/server';
import {
  getApprovedVersion,
  parseContent,
  parseDefinition,
  publishMachineVersion,
  requireMachineVersion,
} from './lib/content';
import { machineDefinitionValidator, procedureContentValidator } from './lib/validators';

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object).sort().map((key) => [key, sortObjectKeys(object[key])]),
    );
  }
  return value;
}

function deepEqualIgnoringKeyOrder(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortObjectKeys(left)) === JSON.stringify(sortObjectKeys(right));
}

export const uploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

export const machineStatus = internalQuery({
  args: { slug: v.string() },
  returns: v.object({
    exists: v.boolean(),
    definition: v.optional(machineDefinitionValidator),
    version: v.optional(v.number()),
  }),
  handler: async (ctx, { slug }) => {
    const machine = await ctx.db
      .query('machines')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique();
    if (machine === null) {
      return { exists: false };
    }
    const currentVersion = machine.currentVersionId === undefined
      ? null
      : await ctx.db.get(machine.currentVersionId);
    return {
      exists: true,
      definition: currentVersion?.definition,
      version: currentVersion?.version,
    };
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
    version: v.optional(v.number()),
    created: v.boolean(),
    updated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const machine = await ctx.db
      .query('machines')
      .withIndex('by_slug', (q) => q.eq('slug', args.slug))
      .unique();
    const currentVersion = machine?.currentVersionId === undefined
      ? null
      : await ctx.db.get(machine.currentVersionId);
    if (machine !== null && currentVersion !== null && deepEqualIgnoringKeyOrder(args.definition, currentVersion.definition)) {
      return {
        machineId: machine._id,
        machineVersionId: currentVersion._id,
        version: currentVersion.version,
        created: false,
        updated: false,
      };
    }
    const result = await publishMachineVersion(ctx, args);
    return { ...result, created: machine === null, updated: machine !== null };
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
    v.object({
      created: v.literal(true), updated: v.literal(false),
      versionId: v.id('procedureVersions'), version: v.number(),
    }),
    v.object({
      created: v.literal(false), updated: v.literal(true),
      versionId: v.id('procedureVersions'), version: v.number(),
    }),
    v.object({
      created: v.literal(false), updated: v.literal(false),
      reason: v.union(v.literal('unchanged'), v.literal('human-authored')),
    }),
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
    const versions = existing === null ? [] : await ctx.db
      .query('procedureVersions')
      .withIndex('by_procedure', (q) => q.eq('procedureId', existing._id))
      .collect();
    const approved = existing === null ? null : await getApprovedVersion(ctx, existing);
    if (existing !== null) {
      const seedManaged = approved !== null && versions.every((version) =>
        version.changeNote === 'Seeded' && version.createdBy === undefined,
      );
      if (!seedManaged) {
        return { created: false as const, updated: false as const, reason: 'human-authored' as const };
      }
      if (deepEqualIgnoringKeyOrder(rawContent, approved.content)) {
        return { created: false as const, updated: false as const, reason: 'unchanged' as const };
      }
    }
    const machineVersion = await requireMachineVersion(ctx, machine.currentVersionId);
    const content = parseContent(rawContent);
    const definition = parseDefinition(machineVersion.definition);
    const issues = validateProcedure(content, definition, linkTargets);
    if (issues.length > 0) {
      const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
      throw new ConvexError(`Invalid procedure references:\n${details}`);
    }
    const procedureId = existing?._id
      ?? await ctx.db.insert('procedures', { machineId: machine._id, slug });
    const version = versions.reduce((max, entry) => Math.max(max, entry.version), 0) + 1;
    const versionId = await ctx.db.insert('procedureVersions', {
      procedureId,
      version,
      status: 'approved',
      machineVersionId: machineVersion._id,
      content,
      approvedAt: Date.now(),
      changeNote: 'Seeded',
    });
    if (approved !== null) {
      await ctx.db.patch(approved._id, { status: 'retired' });
    }
    await ctx.db.patch(procedureId, { approvedVersionId: versionId });
    return existing === null
      ? { created: true as const, updated: false as const, versionId, version }
      : { created: false as const, updated: true as const, versionId, version };
  },
});

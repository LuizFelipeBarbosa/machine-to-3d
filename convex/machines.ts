import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { hasRole, requireRole, requireUser } from './lib/authz';
import {
  getApprovedVersion,
  getDraft,
  getLatestVersion,
  parseContent,
  parseDefinition,
} from './lib/content';
import { machineDefinitionValidator } from './lib/validators';

export const list = query({
  args: {},
  returns: v.array(v.object({
    _id: v.id('machines'),
    slug: v.string(),
    name: v.string(),
    kind: v.string(),
    currentVersionId: v.optional(v.id('machineVersions')),
    procedures: v.array(v.object({
      _id: v.id('procedures'),
      slug: v.string(),
      title: v.string(),
      minutes: v.number(),
      hasApproved: v.boolean(),
      hasDraft: v.boolean(),
    })),
  })),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const canAuthor = hasRole(user, 'author');
    const machines = await ctx.db.query('machines').collect();
    machines.sort((a, b) => a.name.localeCompare(b.name));

    const result = [];
    for (const machine of machines) {
      const procedures = await ctx.db
        .query('procedures')
        .withIndex('by_machine', (q) => q.eq('machineId', machine._id))
        .collect();
      const summaries = [];
      for (const procedure of procedures) {
        const approved = await getApprovedVersion(ctx, procedure);
        if (!canAuthor && approved === null) {
          continue;
        }
        const version = approved ?? await getLatestVersion(ctx, procedure._id);
        if (version === null) {
          continue;
        }
        const content = parseContent(version.content);
        const hasDraft = canAuthor && await getDraft(ctx, procedure._id) !== null;
        summaries.push({
          _id: procedure._id,
          slug: procedure.slug,
          title: content.title,
          minutes: content.minutes,
          hasApproved: approved !== null,
          hasDraft,
        });
      }
      result.push({
        _id: machine._id,
        slug: machine.slug,
        name: machine.name,
        kind: machine.kind,
        currentVersionId: machine.currentVersionId,
        procedures: summaries,
      });
    }
    return result;
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  returns: v.union(v.object({
    _id: v.id('machines'),
    slug: v.string(),
    name: v.string(),
    kind: v.string(),
    version: v.object({
      _id: v.id('machineVersions'),
      version: v.number(),
      definition: machineDefinitionValidator,
      modelUrl: v.union(v.string(), v.null()),
    }),
  }), v.null()),
  handler: async (ctx, { slug }) => {
    await requireUser(ctx);
    const machine = await ctx.db
      .query('machines')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique();
    if (machine?.currentVersionId === undefined) {
      return null;
    }
    const version = await ctx.db.get(machine.currentVersionId);
    if (version === null) {
      return null;
    }
    return {
      _id: machine._id,
      slug: machine.slug,
      name: machine.name,
      kind: machine.kind,
      version: {
        _id: version._id,
        version: version.version,
        definition: parseDefinition(version.definition),
        modelUrl: await ctx.storage.getUrl(version.modelFileId),
      },
    };
  },
});

export const listVersions = query({
  args: { machineId: v.id('machines') },
  returns: v.array(v.object({
    _id: v.id('machineVersions'),
    version: v.number(),
    _creationTime: v.number(),
  })),
  handler: async (ctx, { machineId }) => {
    await requireRole(ctx, 'author');
    const versions = await ctx.db
      .query('machineVersions')
      .withIndex('by_machine', (q) => q.eq('machineId', machineId))
      .order('desc')
      .collect();
    return versions.map(({ _id, version, _creationTime }) => ({ _id, version, _creationTime }));
  },
});

export const publishVersion = mutation({
  args: {
    slug: v.string(),
    name: v.string(),
    kind: v.string(),
    modelFileId: v.id('_storage'),
    definition: machineDefinitionValidator,
  },
  returns: v.object({
    machineId: v.id('machines'),
    machineVersionId: v.id('machineVersions'),
    version: v.number(),
  }),
  handler: async (ctx, { slug, name, kind, modelFileId, definition: rawDefinition }) => {
    await requireRole(ctx, 'admin');
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
      modelFileId,
      definition,
    });
    await ctx.db.patch(machineId, { name, kind, currentVersionId: machineVersionId });
    return { machineId, machineVersionId, version };
  },
});

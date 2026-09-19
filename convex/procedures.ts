import { ConvexError, v } from 'convex/values';
import { validateProcedure } from '../shared/validateProcedure';
import type { ProcedureContent } from '../shared/procedure';
import { mutation, query } from './_generated/server';
import type { QueryCtx } from './_generated/server';
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
const mediaUrlsValidator = v.record(v.string(), v.string());
const versionSummaryValidator = v.object({
  _id: v.id('procedureVersions'),
  version: v.number(),
  status: versionStatusValidator,
  _creationTime: v.number(),
  approvedAt: v.optional(v.number()),
  changeNote: v.optional(v.string()),
});

async function mediaUrlsForContent(ctx: QueryCtx, contents: ProcedureContent[]) {
  const fileIds = new Set(contents.flatMap((content) =>
    content.steps.flatMap((step) => step.media ? [step.media.fileId] : []),
  ));
  const entries: [string, string][] = [];
  for (const fileId of fileIds) {
    // Local content may use URLs; those are rendered directly by the player.
    const storageId = ctx.db.system.normalizeId('_storage', fileId);
    if (storageId === null) continue;
    const url = await ctx.storage.getUrl(storageId);
    if (url !== null) entries.push([fileId, url]);
  }
  return Object.fromEntries(entries);
}

export const getEditorContext = query({
  args: { machineSlug: v.string(), procedureSlug: v.string() },
  returns: v.union(v.object({
    procedureId: v.id('procedures'),
    machineId: v.id('machines'),
    machineSlug: v.string(),
    machineName: v.string(),
    definition: machineDefinitionValidator,
    modelUrl: v.union(v.string(), v.null()),
    versions: v.array(versionSummaryValidator),
    draftId: v.optional(v.id('procedureVersions')),
    approvedId: v.optional(v.id('procedureVersions')),
    linkTargets: linkTargetsValidator,
    procedureTitles: v.record(v.string(), v.string()),
    mediaUrls: mediaUrlsValidator,
  }), v.null()),
  handler: async (ctx, { machineSlug, procedureSlug }) => {
    await requireRole(ctx, 'author');
    const machine = await ctx.db.query('machines')
      .withIndex('by_slug', (q) => q.eq('slug', machineSlug)).unique();
    if (machine === null) return null;
    const procedure = await ctx.db.query('procedures')
      .withIndex('by_machine_slug', (q) =>
        q.eq('machineId', machine._id).eq('slug', procedureSlug),
      ).unique();
    if (procedure === null) return null;

    const versions = await ctx.db.query('procedureVersions')
      .withIndex('by_procedure', (q) => q.eq('procedureId', procedure._id))
      .order('desc').collect();
    const draft = versions.find((version) => version.status === 'draft');
    const approved = await getApprovedVersion(ctx, procedure);
    const machineVersion = await requireMachineVersion(
      ctx, (draft ?? approved)?.machineVersionId ?? machine.currentVersionId,
    );
    const procedures = await ctx.db.query('procedures')
      .withIndex('by_machine', (q) => q.eq('machineId', machine._id)).collect();
    const linkEntries: [string, string[]][] = [];
    const titleEntries: [string, string][] = [];
    const mediaContents: ProcedureContent[] = [];
    for (const entry of procedures) {
      const version = await getApprovedVersion(ctx, entry);
      if (version === null) continue;
      const content = parseContent(version.content);
      linkEntries.push([entry.slug, content.steps.map((step) => step.id)]);
      titleEntries.push([entry.slug, content.title]);
      mediaContents.push(content);
    }
    const linkTargets = Object.fromEntries(linkEntries);
    if (draft) {
      const content = parseContent(draft.content);
      linkTargets[procedure.slug] = [...new Set([
        ...(linkTargets[procedure.slug] ?? []),
        ...content.steps.map((step) => step.id),
      ])];
      titleEntries.push([procedure.slug, content.title]);
      mediaContents.push(content);
    }
    return {
      procedureId: procedure._id,
      machineId: machine._id,
      machineSlug: machine.slug,
      machineName: machine.name,
      definition: parseDefinition(machineVersion.definition),
      modelUrl: await ctx.storage.getUrl(machineVersion.modelFileId),
      versions: versions.map(({ _id, version, status, _creationTime, approvedAt, changeNote }) => ({
        _id, version, status, _creationTime, approvedAt, changeNote,
      })),
      draftId: draft?._id,
      approvedId: approved?._id,
      linkTargets,
      procedureTitles: Object.fromEntries(titleEntries),
      mediaUrls: await mediaUrlsForContent(ctx, mediaContents),
    };
  },
});

export const listForMachine = query({
  args: { machineId: v.id('machines') },
  returns: v.array(v.object({
    _id: v.id('procedures'),
    slug: v.string(),
    title: v.string(),
    hasDraft: v.boolean(),
    hasApproved: v.boolean(),
  })),
  handler: async (ctx, { machineId }) => {
    await requireRole(ctx, 'author');
    await requireMachine(ctx, machineId);
    const procedures = await ctx.db.query('procedures')
      .withIndex('by_machine', (q) => q.eq('machineId', machineId)).collect();
    const summaries = [];
    for (const procedure of procedures) {
      const draft = await getDraft(ctx, procedure._id);
      const approved = await getApprovedVersion(ctx, procedure);
      const version = draft ?? approved ?? await getLatestVersion(ctx, procedure._id);
      summaries.push({
        _id: procedure._id,
        slug: procedure.slug,
        title: version ? parseContent(version.content).title : procedure.slug,
        hasDraft: draft !== null,
        hasApproved: approved !== null,
      });
    }
    return summaries.sort((a, b) => a.title.localeCompare(b.title));
  },
});

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
    mediaUrls: mediaUrlsValidator,
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
      mediaUrls: await mediaUrlsForContent(ctx, [parseContent(version.content)]),
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
    mediaUrls: mediaUrlsValidator,
    machineSlug: v.string(),
    procedureSlug: v.string(),
  }),
  handler: async (ctx, { versionId }) => {
    await requireRole(ctx, 'author');
    const version = await requireVersion(ctx, versionId);
    const procedure = await requireProcedure(ctx, version.procedureId);
    const machine = await requireMachine(ctx, procedure.machineId);
    const machineVersion = await requireMachineVersion(ctx, version.machineVersionId);
    const content = parseContent(version.content);
    const linkTargets = await linkTargetsForMachine(ctx, machine._id);
    linkTargets[procedure.slug] = content.steps.map((step) => step.id);
    return {
      _id: version._id,
      procedureId: procedure._id,
      version: version.version,
      status: version.status,
      machineVersionId: machineVersion._id,
      content,
      changeNote: version.changeNote,
      approvedAt: version.approvedAt,
      createdBy: version.createdBy,
      modelUrl: await ctx.storage.getUrl(machineVersion.modelFileId),
      definition: parseDefinition(machineVersion.definition),
      linkTargets,
      mediaUrls: await mediaUrlsForContent(ctx, [content]),
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
    if (source !== null && source.procedureId !== procedureId) {
      throw new ConvexError('Source version belongs to another procedure');
    }
    const machine = await requireMachine(ctx, procedure.machineId);
    const machineVersion = await requireMachineVersion(ctx, machine.currentVersionId);
    return ctx.db.insert('procedureVersions', {
      procedureId,
      version: (latest?.version ?? 0) + 1,
      status: 'draft',
      machineVersionId: machineVersion._id,
      content: source === null
        ? emptyProcedureContent(procedure.slug, parseDefinition(machineVersion.definition))
        : parseContent(source.content),
      copiedFromVersionId: source?._id,
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

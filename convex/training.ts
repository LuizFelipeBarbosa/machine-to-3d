import { ConvexError, v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import type { QueryCtx } from './_generated/server';
import { requireRole, requireUser } from './lib/authz';
import { requireMachine, requireProcedure, requireVersion } from './lib/content';
import { checkpointValidator } from './lib/validators';

const summaryFields = {
  _id: v.id('trainingRecords'),
  completedAt: v.number(),
  checkpointCount: v.number(),
  signedOffAt: v.optional(v.number()),
  signedOffByName: v.optional(v.string()),
  procedureTitle: v.string(),
  procedureSlug: v.string(),
  machineSlug: v.string(),
  machineName: v.string(),
  version: v.number(),
};

async function summarizeRecord(ctx: QueryCtx, record: Doc<'trainingRecords'>) {
  const version = await requireVersion(ctx, record.procedureVersionId);
  const procedure = await requireProcedure(ctx, version.procedureId);
  const machine = await requireMachine(ctx, procedure.machineId);
  const signer = record.signedOffBy === undefined ? null : await ctx.db.get(record.signedOffBy);
  return {
    _id: record._id,
    completedAt: record.completedAt,
    checkpointCount: record.selfAttestedCheckpoints.length,
    signedOffAt: record.signedOffAt,
    signedOffByName: signer?.name,
    procedureTitle: version.content.title,
    procedureSlug: procedure.slug,
    machineSlug: machine.slug,
    machineName: machine.name,
    version: version.version,
  };
}

export const complete = mutation({
  args: {
    procedureVersionId: v.id('procedureVersions'),
    checkpoints: v.array(checkpointValidator),
  },
  returns: v.id('trainingRecords'),
  handler: async (ctx, { procedureVersionId, checkpoints }) => {
    const user = await requireUser(ctx);
    const version = await requireVersion(ctx, procedureVersionId);
    if (version.status !== 'approved') {
      throw new ConvexError('Only approved procedures are recorded');
    }
    const stepIds = new Set(version.content.steps.map((step) => step.id));
    for (const checkpoint of checkpoints) {
      if (!stepIds.has(checkpoint.stepId)) {
        throw new ConvexError(`Unknown checkpoint step: ${checkpoint.stepId}`);
      }
    }
    return ctx.db.insert('trainingRecords', {
      userId: user._id,
      procedureVersionId,
      completedAt: Date.now(),
      selfAttestedCheckpoints: checkpoints,
    });
  },
});

export const listMine = query({
  args: {},
  returns: v.array(v.object(summaryFields)),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const records = await ctx.db
      .query('trainingRecords')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .order('desc')
      .collect();
    records.sort((a, b) => b.completedAt - a.completedAt);
    return Promise.all(records.map((record) => summarizeRecord(ctx, record)));
  },
});

export const listAll = query({
  args: {},
  returns: v.array(v.object({
    ...summaryFields,
    userId: v.id('users'),
    userName: v.optional(v.string()),
    userEmail: v.optional(v.string()),
  })),
  handler: async (ctx) => {
    await requireRole(ctx, 'approver');
    const records = await ctx.db.query('trainingRecords').order('desc').collect();
    records.sort((a, b) => b.completedAt - a.completedAt);
    return Promise.all(records.map(async (record) => {
      const user = await ctx.db.get(record.userId);
      return {
        ...await summarizeRecord(ctx, record),
        userId: record.userId,
        userName: user?.name,
        userEmail: user?.email,
      };
    }));
  },
});

export const signOff = mutation({
  args: { recordId: v.id('trainingRecords'), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { recordId, note }) => {
    const user = await requireRole(ctx, 'approver');
    const record = await ctx.db.get(recordId);
    if (record === null) {
      throw new ConvexError('Training record not found');
    }
    if (record.userId === user._id) {
      throw new ConvexError('You cannot sign off your own record');
    }
    if (record.signedOffAt !== undefined || record.signedOffBy !== undefined) {
      throw new ConvexError('Record already signed off');
    }
    await ctx.db.patch(recordId, {
      signedOffBy: user._id,
      signedOffAt: Date.now(),
      signOffNote: note,
    });
    return null;
  },
});

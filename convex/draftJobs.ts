import { ConvexError, v } from 'convex/values';
import type { Infer } from 'convex/values';
import { contentHash } from '../shared/contentHash';
import type { ProcedureContent } from '../shared/procedure';
import { validateProcedure } from '../shared/validateProcedure';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { hasRole, requireRole } from './lib/authz';
import {
  getApprovedVersion,
  getLatestVersion,
  linkTargetsForMachine,
  parseContent,
  parseDefinition,
  publishMachineVersion,
  requireAdditiveDefinition,
  requireCompatibleApprovedProcedures,
  requireMachine,
  requireMachineVersion,
  requireProcedure,
  requireVersion,
} from './lib/content';
import {
  draftJobKindValidator,
  draftJobStatusValidator,
  jobEventLevelValidator,
  newMachineValidator,
} from './schema';

const jobSummaryValidator = v.object({
  _id: v.id('draftJobs'),
  kind: draftJobKindValidator,
  status: draftJobStatusValidator,
  stage: v.string(),
  title: v.string(),
  procedureSlug: v.string(),
  machineSlug: v.string(),
  attempts: v.number(),
  lastError: v.optional(v.string()),
  modelChanged: v.optional(v.boolean()),
  producedProcedureVersionId: v.optional(v.id('procedureVersions')),
  _creationTime: v.number(),
  updatedAt: v.number(),
});

const storageUrlValidator = v.union(v.string(), v.null());
const claimedJobValidator = v.object({
  jobId: v.id('draftJobs'),
  kind: draftJobKindValidator,
  stage: v.string(),
  attempts: v.number(),
  workspaceKey: v.string(),
  codexSessionId: v.optional(v.string()),
  machine: v.object({
    slug: v.string(),
    name: v.string(),
    kind: v.string(),
    machineId: v.optional(v.id('machines')),
    current: v.optional(v.object({
      machineVersionId: v.id('machineVersions'),
      version: v.number(),
      definition: v.any(),
      modelUrl: storageUrlValidator,
      sourceUrl: v.optional(storageUrlValidator),
    })),
  }),
  procedureSlug: v.string(),
  title: v.string(),
  brief: v.string(),
  instruction: v.optional(v.string()),
  videoUrl: v.optional(storageUrlValidator),
  target: v.optional(v.object({
    procedureVersionId: v.id('procedureVersions'),
    machineVersionId: v.id('machineVersions'),
    content: v.any(),
    definition: v.any(),
    contentHash: v.string(),
    modelUrl: storageUrlValidator,
  })),
  approvedProcedures: v.array(v.object({ slug: v.string(), content: v.any() })),
  leaseSeconds: v.number(),
});

async function requireJob(ctx: QueryCtx, jobId: Id<'draftJobs'>) {
  const job = await ctx.db.get(jobId);
  if (job === null) throw new ConvexError('Job not found');
  return job;
}

async function requireAccessibleJob(ctx: QueryCtx, jobId: Id<'draftJobs'>) {
  const user = await requireRole(ctx, 'author');
  const job = await requireJob(ctx, jobId);
  if (job.requestedBy !== user._id && !hasRole(user, 'approver')) {
    throw new ConvexError('Not authorized');
  }
  return job;
}

function requireLease(job: Doc<'draftJobs'>, workerId: string) {
  if (job.workerId !== workerId) throw new ConvexError('Lease lost');
  if (job.status !== 'running') throw new ConvexError('Job is not running');
}

async function requireAvailableWorkspace(ctx: QueryCtx, workspaceKey: string) {
  for (const status of ['queued', 'running'] as const) {
    const active = await ctx.db.query('draftJobs')
      .withIndex('by_workspace', (q) => q.eq('workspaceKey', workspaceKey).eq('status', status))
      .first();
    if (active !== null) throw new ConvexError('A job is already running for this machine');
  }
}

async function requireAvailableTarget(ctx: QueryCtx, versionId: Id<'procedureVersions'>) {
  for (const status of ['queued', 'running'] as const) {
    const active = await ctx.db.query('draftJobs')
      .withIndex('by_target', (q) => q.eq('targetProcedureVersionId', versionId).eq('status', status))
      .first();
    if (active !== null) throw new ConvexError('A revision is already running for this draft');
  }
}

async function summarizeJob(ctx: QueryCtx, job: Doc<'draftJobs'>) {
  const machineSlug = job.machineId === undefined
    ? job.newMachine?.slug ?? job.workspaceKey
    : (await requireMachine(ctx, job.machineId)).slug;
  return {
    _id: job._id,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    title: job.title,
    procedureSlug: job.procedureSlug,
    machineSlug,
    attempts: job.attempts,
    lastError: job.lastError,
    modelChanged: job.modelChanged,
    producedProcedureVersionId: job.producedProcedureVersionId,
    _creationTime: job._creationTime,
    updatedAt: job.updatedAt,
  };
}

export const create = mutation({
  args: {
    machineId: v.optional(v.id('machines')),
    newMachine: v.optional(newMachineValidator),
    procedureSlug: v.string(),
    title: v.string(),
    brief: v.string(),
    videoFileId: v.id('_storage'),
  },
  returns: v.id('draftJobs'),
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, 'author');
    if ((args.machineId === undefined) === (args.newMachine === undefined)) {
      throw new ConvexError('Choose an existing machine or describe a new one');
    }
    if (!/^[a-z0-9-]+$/.test(args.procedureSlug)) {
      throw new ConvexError('Invalid procedure slug');
    }
    let workspaceKey: string;
    if (args.newMachine !== undefined) {
      if (!/^[a-z0-9-]+$/.test(args.newMachine.slug)) {
        throw new ConvexError('Invalid machine slug');
      }
      const existing = await ctx.db.query('machines')
        .withIndex('by_slug', (q) => q.eq('slug', args.newMachine!.slug)).unique();
      if (existing !== null) throw new ConvexError('Slug already used');
      workspaceKey = args.newMachine.slug;
    } else {
      const machine = await requireMachine(ctx, args.machineId!);
      const existing = await ctx.db.query('procedures')
        .withIndex('by_machine_slug', (q) => q.eq('machineId', machine._id).eq('slug', args.procedureSlug))
        .unique();
      if (existing !== null) throw new ConvexError('Slug already used');
      workspaceKey = machine.slug;
    }
    await requireAvailableWorkspace(ctx, workspaceKey);
    return ctx.db.insert('draftJobs', {
      ...args,
      kind: 'create',
      status: 'queued',
      stage: 'queued',
      attempts: 0,
      requestedBy: user._id,
      workspaceKey,
      updatedAt: Date.now(),
    });
  },
});

export const createRevision = mutation({
  args: { procedureVersionId: v.id('procedureVersions'), instruction: v.string() },
  returns: v.id('draftJobs'),
  handler: async (ctx, { procedureVersionId, instruction }) => {
    const user = await requireRole(ctx, 'author');
    const version = await requireVersion(ctx, procedureVersionId);
    if (version.status !== 'draft') throw new ConvexError('Only drafts can be revised');
    if (!instruction.trim()) throw new ConvexError('Instruction is required');
    await requireAvailableTarget(ctx, procedureVersionId);
    const procedure = await requireProcedure(ctx, version.procedureId);
    const machine = await requireMachine(ctx, procedure.machineId);
    await requireAvailableWorkspace(ctx, machine.slug);
    const content = parseContent(version.content);
    return ctx.db.insert('draftJobs', {
      kind: 'revise',
      machineId: machine._id,
      procedureSlug: procedure.slug,
      title: content.title,
      brief: '',
      instruction,
      targetProcedureVersionId: procedureVersionId,
      targetMachineVersionId: version.machineVersionId,
      sourceContentHash: contentHash(version.content),
      snapshotContent: content,
      videoFileId: version.sourceVideoFileId,
      workspaceKey: machine.slug,
      status: 'queued',
      stage: 'queued',
      attempts: 0,
      requestedBy: user._id,
      updatedAt: Date.now(),
    });
  },
});

export const listMine = query({
  args: {},
  returns: v.array(jobSummaryValidator),
  handler: async (ctx) => {
    const user = await requireRole(ctx, 'author');
    const jobs = await ctx.db.query('draftJobs')
      .withIndex('by_requester', (q) => q.eq('requestedBy', user._id)).order('desc').take(100);
    return Promise.all(jobs.map((job) => summarizeJob(ctx, job)));
  },
});

export const list = query({
  args: {},
  returns: v.array(jobSummaryValidator),
  handler: async (ctx) => {
    await requireRole(ctx, 'approver');
    const jobs = await ctx.db.query('draftJobs').order('desc').take(100);
    return Promise.all(jobs.map((job) => summarizeJob(ctx, job)));
  },
});

export const get = query({
  args: { jobId: v.id('draftJobs') },
  returns: v.object({
    ...jobSummaryValidator.fields,
    brief: v.string(),
    instruction: v.optional(v.string()),
    newMachine: v.optional(newMachineValidator),
    machineId: v.optional(v.id('machines')),
    targetProcedureVersionId: v.optional(v.id('procedureVersions')),
    producedMachineVersionId: v.optional(v.id('machineVersions')),
  }),
  handler: async (ctx, { jobId }) => {
    const job = await requireAccessibleJob(ctx, jobId);
    return {
      ...await summarizeJob(ctx, job),
      brief: job.brief,
      instruction: job.instruction,
      newMachine: job.newMachine,
      machineId: job.machineId,
      targetProcedureVersionId: job.targetProcedureVersionId,
      producedMachineVersionId: job.producedMachineVersionId,
    };
  },
});

export const events = query({
  args: { jobId: v.id('draftJobs') },
  returns: v.array(v.object({ at: v.number(), level: jobEventLevelValidator, message: v.string() })),
  handler: async (ctx, { jobId }) => {
    await requireAccessibleJob(ctx, jobId);
    const rows = await ctx.db.query('jobEvents')
      .withIndex('by_job_at', (q) => q.eq('jobId', jobId)).order('asc').take(500);
    return rows.map(({ at, level, message }) => ({ at, level, message }));
  },
});

export const cancel = mutation({
  args: { jobId: v.id('draftJobs') },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    const job = await requireAccessibleJob(ctx, jobId);
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new ConvexError('Job is not active');
    }
    await ctx.db.patch(jobId, {
      status: 'cancelled', workerId: undefined, leaseUntil: undefined, updatedAt: Date.now(),
    });
    return null;
  },
});

export const retry = mutation({
  args: { jobId: v.id('draftJobs') },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    const job = await requireAccessibleJob(ctx, jobId);
    if (job.status !== 'failed') throw new ConvexError('Only failed jobs can be retried');
    let refreshedInputs: {
      sourceContentHash: string;
      snapshotContent: ProcedureContent;
    } | undefined;
    if (job.kind === 'revise') {
      if (job.targetProcedureVersionId === undefined) {
        throw new ConvexError('Target draft no longer exists');
      }
      await requireAvailableTarget(ctx, job.targetProcedureVersionId);
      const target = await ctx.db.get(job.targetProcedureVersionId);
      if (target?.status !== 'draft') {
        throw new ConvexError('Target draft no longer exists');
      }
      refreshedInputs = {
        sourceContentHash: contentHash(target.content),
        snapshotContent: parseContent(target.content),
      };
    } else if (job.targetProcedureVersionId !== undefined) {
      await requireAvailableTarget(ctx, job.targetProcedureVersionId);
    }
    await requireAvailableWorkspace(ctx, job.workspaceKey);
    await ctx.db.patch(jobId, {
      status: 'queued', lastError: undefined, workerId: undefined,
      leaseUntil: undefined, updatedAt: Date.now(), ...refreshedInputs,
    });
    return null;
  },
});

async function buildClaimPayload(
  ctx: QueryCtx,
  job: Doc<'draftJobs'>,
  leaseSeconds: number,
): Promise<Infer<typeof claimedJobValidator>> {
  const existingMachine = job.machineId === undefined ? null : await requireMachine(ctx, job.machineId);
  const machine = existingMachine ?? job.newMachine;
  if (machine === undefined) throw new ConvexError('Machine not found');

  let current: Infer<typeof claimedJobValidator>['machine']['current'];
  const approvedProcedures: Infer<typeof claimedJobValidator>['approvedProcedures'] = [];
  if (existingMachine !== null) {
    if (existingMachine.currentVersionId !== undefined) {
      const version = await requireMachineVersion(ctx, existingMachine.currentVersionId);
      current = {
        machineVersionId: version._id,
        version: version.version,
        definition: version.definition,
        modelUrl: await ctx.storage.getUrl(version.modelFileId),
        sourceUrl: version.sourceFileId === undefined ? undefined : await ctx.storage.getUrl(version.sourceFileId),
      };
    }
    const procedures = await ctx.db.query('procedures')
      .withIndex('by_machine', (q) => q.eq('machineId', existingMachine._id)).collect();
    for (const procedure of procedures) {
      const approved = await getApprovedVersion(ctx, procedure);
      if (approved !== null) approvedProcedures.push({ slug: procedure.slug, content: approved.content });
    }
  }

  let target: Infer<typeof claimedJobValidator>['target'];
  if (job.kind === 'revise') {
    if (job.targetProcedureVersionId === undefined || job.sourceContentHash === undefined) {
      throw new ConvexError('Revision target not found');
    }
    const version = await requireVersion(ctx, job.targetProcedureVersionId);
    const machineVersion = await requireMachineVersion(ctx, job.targetMachineVersionId);
    target = {
      procedureVersionId: version._id,
      machineVersionId: machineVersion._id,
      content: version.content,
      definition: machineVersion.definition,
      contentHash: job.sourceContentHash,
      modelUrl: await ctx.storage.getUrl(machineVersion.modelFileId),
    };
  }
  return {
    jobId: job._id,
    kind: job.kind,
    stage: job.stage,
    attempts: job.attempts,
    workspaceKey: job.workspaceKey,
    codexSessionId: job.codexSessionId,
    machine: { slug: machine.slug, name: machine.name, kind: machine.kind, machineId: job.machineId, current },
    procedureSlug: job.procedureSlug,
    title: job.title,
    brief: job.brief,
    instruction: job.instruction,
    videoUrl: job.videoFileId === undefined ? undefined : await ctx.storage.getUrl(job.videoFileId),
    target,
    approvedProcedures,
    leaseSeconds,
  };
}

async function failExhaustedJob(ctx: MutationCtx, job: Doc<'draftJobs'>, at: number) {
  await ctx.db.patch(job._id, {
    status: 'failed', lastError: 'Too many attempts', leaseUntil: undefined, updatedAt: at,
  });
  await ctx.db.insert('jobEvents', {
    jobId: job._id, at, level: 'error', message: 'Too many attempts',
  });
}

export const claim = internalMutation({
  args: { workerId: v.string(), leaseSeconds: v.number() },
  returns: v.union(v.null(), claimedJobValidator),
  handler: async (ctx, { workerId, leaseSeconds: requestedLeaseSeconds }) => {
    if (!Number.isFinite(requestedLeaseSeconds)) {
      throw new ConvexError('Lease length must be positive');
    }
    const leaseSeconds = Math.min(3600, Math.max(30, requestedLeaseSeconds));
    const now = Date.now();
    let job: Doc<'draftJobs'> | null = null;
    const queued = ctx.db.query('draftJobs')
      .withIndex('by_status', (q) => q.eq('status', 'queued')).order('asc');
    for await (const candidate of queued) {
      if (candidate.attempts >= 5) {
        await failExhaustedJob(ctx, candidate, now);
        continue;
      }
      job = candidate;
      break;
    }
    if (job === null) {
      const running = ctx.db.query('draftJobs')
        .withIndex('by_status', (q) => q.eq('status', 'running')).order('asc');
      for await (const candidate of running) {
        if (candidate.leaseUntil !== undefined && candidate.leaseUntil < now) {
          if (candidate.attempts >= 5) {
            await failExhaustedJob(ctx, candidate, now);
            continue;
          }
          job = candidate;
          break;
        }
      }
    }
    if (job === null) return null;
    const changes = {
      status: 'running' as const,
      stage: job.stage === 'queued' ? 'claimed' : job.stage,
      workerId,
      leaseUntil: now + leaseSeconds * 1000,
      leaseSeconds,
      heartbeatAt: now,
      attempts: job.attempts + 1,
      updatedAt: now,
    };
    await ctx.db.patch(job._id, changes);
    return buildClaimPayload(ctx, { ...job, ...changes }, leaseSeconds);
  },
});

export const checkLease = internalQuery({
  args: { jobId: v.id('draftJobs'), workerId: v.string() },
  returns: v.null(),
  handler: async (ctx, { jobId, workerId }) => {
    requireLease(await requireJob(ctx, jobId), workerId);
    return null;
  },
});

export const heartbeat = internalMutation({
  args: { jobId: v.id('draftJobs'), workerId: v.string() },
  returns: v.object({ status: v.union(v.literal('running'), v.literal('cancelled')) }),
  handler: async (ctx, { jobId, workerId }) => {
    const job = await requireJob(ctx, jobId);
    if (job.status === 'cancelled') return { status: 'cancelled' as const };
    requireLease(job, workerId);
    const now = Date.now();
    await ctx.db.patch(jobId, {
      leaseUntil: now + (job.leaseSeconds ?? 300) * 1000, heartbeatAt: now,
    });
    return { status: 'running' as const };
  },
});

export const appendEvent = internalMutation({
  args: { jobId: v.id('draftJobs'), workerId: v.string(), level: jobEventLevelValidator, message: v.string() },
  returns: v.null(),
  handler: async (ctx, { jobId, workerId, level, message }) => {
    requireLease(await requireJob(ctx, jobId), workerId);
    await ctx.db.insert('jobEvents', { jobId, at: Date.now(), level, message });
    return null;
  },
});

export const setStage = internalMutation({
  args: { jobId: v.id('draftJobs'), workerId: v.string(), stage: v.string(), codexSessionId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { jobId, workerId, stage, codexSessionId }) => {
    requireLease(await requireJob(ctx, jobId), workerId);
    await ctx.db.patch(jobId, {
      stage, updatedAt: Date.now(), ...(codexSessionId === undefined ? {} : { codexSessionId }),
    });
    return null;
  },
});

export const fail = internalMutation({
  args: { jobId: v.id('draftJobs'), workerId: v.string(), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { jobId, workerId, error }) => {
    requireLease(await requireJob(ctx, jobId), workerId);
    const now = Date.now();
    await ctx.db.patch(jobId, { status: 'failed', lastError: error, leaseUntil: undefined, updatedAt: now });
    await ctx.db.insert('jobEvents', { jobId, at: now, level: 'error', message: error });
    return null;
  },
});

const deliveryModelValidator = v.object({
  modelFileId: v.id('_storage'),
  sourceFileId: v.optional(v.id('_storage')),
  definition: v.any(),
});

async function machineVersionForDelivery(
  ctx: MutationCtx,
  job: Doc<'draftJobs'>,
  modelChanged: boolean,
  model: Infer<typeof deliveryModelValidator> | undefined,
  rawContent: unknown,
) {
  if (!modelChanged) {
    if (job.kind === 'revise') {
      return requireMachineVersion(ctx, job.targetMachineVersionId);
    }
    const machine = job.machineId === undefined ? null : await requireMachine(ctx, job.machineId);
    if (machine?.currentVersionId === undefined) {
      throw new ConvexError('A new machine needs a model');
    }
    return requireMachineVersion(ctx, machine.currentVersionId);
  }

  if (model === undefined) {
    throw new ConvexError('Model files are required when the model changed');
  }
  const definition = parseDefinition(model.definition);
  // A retried new-machine job may already have a machine row from a partial run.
  let existingMachine: Doc<'machines'> | null = null;
  if (job.machineId !== undefined) {
    existingMachine = await requireMachine(ctx, job.machineId);
  } else if (job.newMachine !== undefined) {
    const { slug } = job.newMachine;
    existingMachine = await ctx.db.query('machines')
      .withIndex('by_slug', (q) => q.eq('slug', slug)).unique();
  }
  const machine = existingMachine ?? job.newMachine;
  if (machine === undefined) throw new ConvexError('Machine not found');
  if (existingMachine?.currentVersionId !== undefined) {
    const current = await requireMachineVersion(ctx, existingMachine.currentVersionId);
    requireAdditiveDefinition(parseDefinition(current.definition), definition);
    const content = parseContent(rawContent);
    const linkTargets = await linkTargetsForMachine(ctx, existingMachine._id);
    linkTargets[job.procedureSlug] = content.steps.map((step) => step.id);
    await requireCompatibleApprovedProcedures(ctx, existingMachine._id, definition, linkTargets);
  }
  const { machineVersionId } = await publishMachineVersion(ctx, {
    slug: machine.slug,
    name: machine.name,
    kind: machine.kind,
    modelFileId: model.modelFileId,
    definition,
    publish: false,
    sourceFileId: model.sourceFileId,
  });
  return requireMachineVersion(ctx, machineVersionId);
}

async function writeProcedureDraft(
  ctx: MutationCtx,
  job: Doc<'draftJobs'>,
  machineVersion: Doc<'machineVersions'>,
  content: ProcedureContent,
) {
  if (job.kind === 'revise') {
    const target = job.targetProcedureVersionId === undefined
      ? null : await ctx.db.get(job.targetProcedureVersionId);
    if (target?.status !== 'draft') throw new ConvexError('Target draft no longer exists');
    if (contentHash(target.content) !== job.sourceContentHash) {
      throw new ConvexError('Draft changed during revision');
    }
    await ctx.db.patch(target._id, {
      content, machineVersionId: machineVersion._id, contentRevision: (target.contentRevision ?? 0) + 1,
    });
    return target._id;
  }

  const procedure = await ctx.db.query('procedures')
    .withIndex('by_machine_slug', (q) =>
      q.eq('machineId', machineVersion.machineId).eq('slug', job.procedureSlug),
    ).unique();
  if (procedure !== null) {
    throw new ConvexError('Procedure slug already exists; choose another slug');
  }
  const procedureId = await ctx.db.insert('procedures', {
    machineId: machineVersion.machineId, slug: job.procedureSlug,
  });
  const latest = await getLatestVersion(ctx, procedureId);
  return ctx.db.insert('procedureVersions', {
    procedureId,
    status: 'draft',
    version: (latest?.version ?? 0) + 1,
    machineVersionId: machineVersion._id,
    content,
    createdBy: job.requestedBy,
    sourceVideoFileId: job.videoFileId,
    contentRevision: 1,
    changeNote: 'Drafted from video',
  });
}

export const deliver = internalMutation({
  args: {
    jobId: v.id('draftJobs'),
    workerId: v.string(),
    modelChanged: v.boolean(),
    model: v.optional(deliveryModelValidator),
    procedure: v.object({ content: v.any() }),
    mediaFileIds: v.optional(v.array(v.string())),
    sourceContentHash: v.optional(v.string()),
    report: v.any(),
  },
  returns: v.object({
    procedureVersionId: v.id('procedureVersions'),
    machineVersionId: v.id('machineVersions'),
  }),
  handler: async (ctx, { jobId, workerId, modelChanged, model, procedure, mediaFileIds }) => {
    const job = await requireJob(ctx, jobId);
    requireLease(job, workerId);

    const machineVersion = await machineVersionForDelivery(ctx, job, modelChanged, model, procedure.content);

    const content = parseContent(procedure.content);
    const linkTargets = await linkTargetsForMachine(ctx, machineVersion.machineId);
    linkTargets[job.procedureSlug] = content.steps.map((step) => step.id);
    const issues = validateProcedure(content, parseDefinition(machineVersion.definition), linkTargets);
    if (issues.length > 0) {
      const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
      throw new ConvexError(`Invalid procedure: ${details}`);
    }

    const procedureVersionId = await writeProcedureDraft(ctx, job, machineVersion, content);

    const now = Date.now();
    await ctx.db.patch(jobId, {
      status: 'done',
      stage: 'done',
      modelChanged,
      producedMachineVersionId: machineVersion._id,
      producedProcedureVersionId: procedureVersionId,
      leaseUntil: undefined,
      workerId: undefined,
      ...(mediaFileIds === undefined ? {} : { mediaFileIds }),
      updatedAt: now,
    });
    await ctx.db.insert('jobEvents', {
      jobId, at: now, level: 'info',
      message: `Delivered: ${modelChanged ? 'created draft' : 'reused'} machine version ${machineVersion._id}; procedure version ${procedureVersionId}`,
    });
    return { procedureVersionId, machineVersionId: machineVersion._id };
  },
});

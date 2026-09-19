import { authTables } from '@convex-dev/auth/server';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
  checkpointValidator,
  machineDefinitionValidator,
  procedureContentValidator,
  roleValidator,
  versionStatusValidator,
} from './lib/validators';

export const draftJobKindValidator = v.union(v.literal('create'), v.literal('revise'));
export const draftJobStatusValidator = v.union(
  v.literal('queued'), v.literal('running'), v.literal('failed'),
  v.literal('done'), v.literal('cancelled'),
);
export const newMachineValidator = v.object({
  slug: v.string(), name: v.string(), kind: v.string(),
});
export const jobEventLevelValidator = v.union(v.literal('info'), v.literal('warn'), v.literal('error'));

export default defineSchema({
  ...authTables,

  users: defineTable({
    ...authTables.users.validator.fields,
    role: v.optional(roleValidator),
  })
    .index('email', ['email'])
    .index('phone', ['phone']),

  machines: defineTable({
    slug: v.string(),
    name: v.string(),
    kind: v.string(),
    currentVersionId: v.optional(v.id('machineVersions')),
  }).index('by_slug', ['slug']),

  machineVersions: defineTable({
    machineId: v.id('machines'),
    version: v.number(),
    status: v.optional(v.union(v.literal('draft'), v.literal('published'))),
    modelFileId: v.id('_storage'),
    sourceFileId: v.optional(v.id('_storage')),
    definition: machineDefinitionValidator,
  }).index('by_machine', ['machineId', 'version']),

  procedures: defineTable({
    machineId: v.id('machines'),
    slug: v.string(),
    approvedVersionId: v.optional(v.id('procedureVersions')),
  })
    .index('by_machine', ['machineId'])
    .index('by_machine_slug', ['machineId', 'slug']),

  procedureVersions: defineTable({
    procedureId: v.id('procedures'),
    version: v.number(),
    status: versionStatusValidator,
    machineVersionId: v.id('machineVersions'),
    content: procedureContentValidator,
    seedMedia: v.optional(v.record(v.string(), v.string())),
    // Absent means 0; only non-editor writers increment this counter.
    contentRevision: v.optional(v.number()),
    sourceVideoFileId: v.optional(v.id('_storage')),
    createdBy: v.optional(v.id('users')),
    approvedBy: v.optional(v.id('users')),
    approvedAt: v.optional(v.number()),
    changeNote: v.optional(v.string()),
    copiedFromVersionId: v.optional(v.id('procedureVersions')),
  })
    .index('by_procedure', ['procedureId', 'version'])
    .index('by_procedure_status', ['procedureId', 'status']),

  draftJobs: defineTable({
    kind: draftJobKindValidator,
    status: draftJobStatusValidator,
    stage: v.string(),
    requestedBy: v.id('users'),
    machineId: v.optional(v.id('machines')),
    newMachine: v.optional(newMachineValidator),
    procedureSlug: v.string(),
    title: v.string(),
    brief: v.string(),
    instruction: v.optional(v.string()),
    videoFileId: v.optional(v.id('_storage')),
    targetProcedureVersionId: v.optional(v.id('procedureVersions')),
    targetMachineVersionId: v.optional(v.id('machineVersions')),
    sourceContentHash: v.optional(v.string()),
    snapshotContent: v.optional(procedureContentValidator),
    workspaceKey: v.string(),
    codexSessionId: v.optional(v.string()),
    parentJobId: v.optional(v.id('draftJobs')),
    attempts: v.number(),
    leaseUntil: v.optional(v.number()),
    // Duration from the most recent claim, reused by heartbeat.
    leaseSeconds: v.optional(v.number()),
    workerId: v.optional(v.string()),
    heartbeatAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    modelChanged: v.optional(v.boolean()),
    mediaFileIds: v.optional(v.array(v.string())),
    producedMachineVersionId: v.optional(v.id('machineVersions')),
    producedProcedureVersionId: v.optional(v.id('procedureVersions')),
    updatedAt: v.number(),
  })
    .index('by_status', ['status'])
    .index('by_target', ['targetProcedureVersionId', 'status'])
    .index('by_requester', ['requestedBy'])
    .index('by_workspace', ['workspaceKey', 'status']),

  jobEvents: defineTable({
    jobId: v.id('draftJobs'),
    at: v.number(),
    level: jobEventLevelValidator,
    message: v.string(),
  }).index('by_job_at', ['jobId', 'at']),

  trainingRecords: defineTable({
    userId: v.id('users'),
    procedureVersionId: v.id('procedureVersions'),
    completedAt: v.number(),
    selfAttestedCheckpoints: v.array(checkpointValidator),
    signedOffBy: v.optional(v.id('users')),
    signedOffAt: v.optional(v.number()),
    signOffNote: v.optional(v.string()),
  })
    .index('by_user', ['userId'])
    .index('by_version', ['procedureVersionId']),
});

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
    modelFileId: v.id('_storage'),
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
    createdBy: v.optional(v.id('users')),
    approvedBy: v.optional(v.id('users')),
    approvedAt: v.optional(v.number()),
    changeNote: v.optional(v.string()),
    copiedFromVersionId: v.optional(v.id('procedureVersions')),
  })
    .index('by_procedure', ['procedureId', 'version'])
    .index('by_procedure_status', ['procedureId', 'status']),

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

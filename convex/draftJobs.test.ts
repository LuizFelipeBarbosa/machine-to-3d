import { readFileSync } from 'node:fs';
import { anyApi } from 'convex/server';
import type { ApiFromModules } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { contentHash } from '../shared/contentHash';
import type { MachineDefinition } from '../shared/machine';
import type * as draftJobs from './draftJobs';
import { emptyProcedureContent, parseDefinition } from './lib/content';
import type * as machines from './machines';
import type * as procedures from './procedures';
import schema from './schema';
import { asUser, createUser, modules } from './test.setup';

// Keep these tests typed without requiring changes to checked-in generated files.
const api = anyApi as unknown as ApiFromModules<{
  draftJobs: typeof draftJobs;
  machines: typeof machines;
  procedures: typeof procedures;
}>;

const definition: MachineDefinition = {
  formatVersion: 1,
  rootNode: 'instrument',
  parts: [{ name: 'head', label: 'Head', blurb: '' }],
  presetViews: [{ name: 'front', label: 'Front', view: { pos: [1, 2, 3], target: [0, 0, 0] } }],
  stateVars: [],
};
const newMachine = { slug: 'new-machine', name: 'New machine', kind: 'instrument' };
const worker = { workerId: 'worker-1', leaseSeconds: 60 };
const templateDefinition = parseDefinition(JSON.parse(readFileSync(
  new URL('../worker/kit/template/machine.json', import.meta.url), 'utf8',
)));

async function setup(machineDefinition = definition) {
  const t = convexTest(schema, modules);
  const adminId = await createUser(t, { email: 'admin@example.com', role: 'admin' });
  const authorId = await createUser(t, { email: 'author@example.com', role: 'author' });
  const otherAuthorId = await createUser(t, { email: 'other@example.com', role: 'author' });
  const approverId = await createUser(t, { email: 'approver@example.com', role: 'approver' });
  const traineeId = await createUser(t, { email: 'trainee@example.com', role: 'trainee' });
  const admin = asUser(t, adminId);
  const author = asUser(t, authorId);
  const modelFileId = await t.run((ctx) => ctx.storage.store(new Blob(['model'])));
  const sourceFileId = await t.run((ctx) => ctx.storage.store(new Blob(['source'])));
  const videoFileId = await t.run((ctx) => ctx.storage.store(new Blob(['video'])));
  const publishArgs = {
    slug: 'machine', name: 'Machine', kind: 'instrument', modelFileId, definition: machineDefinition,
  };
  const machine = await admin.mutation(api.machines.publishVersion, publishArgs);
  await t.run((ctx) => ctx.db.patch(machine.machineVersionId, { sourceFileId }));
  const procedure = await author.mutation(api.procedures.create, {
    machineId: machine.machineId, slug: 'procedure', title: 'Procedure',
  });
  await t.run((ctx) => ctx.db.patch(procedure.versionId, { sourceVideoFileId: videoFileId }));
  return {
    t, admin, author, authorId, otherAuthorId,
    otherAuthor: asUser(t, otherAuthorId),
    approver: asUser(t, approverId),
    trainee: asUser(t, traineeId),
    modelFileId, sourceFileId, videoFileId, publishArgs,
    createArgs: {
      machineId: machine.machineId, procedureSlug: 'from-video',
      title: 'From video', brief: 'Explain the workflow', videoFileId,
    },
    ...machine,
    ...procedure,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('draftJobs.create', () => {
  test('requires exactly one existing or new machine', async () => {
    const { author, createArgs } = await setup();
    for (const args of [
      { ...createArgs, newMachine },
      { ...createArgs, machineId: undefined },
    ]) {
      await expect(author.mutation(api.draftJobs.create, args))
        .rejects.toMatchObject({ data: 'Choose an existing machine or describe a new one' });
    }
  });

  test.each(['', 'Uppercase', 'has space', 'under_score', 'slash/name'])(
    'rejects malformed procedure and machine slugs %j', async (slug) => {
      const { author, createArgs } = await setup();
      await expect(author.mutation(api.draftJobs.create, { ...createArgs, procedureSlug: slug }))
        .rejects.toMatchObject({ data: 'Invalid procedure slug' });
      await expect(author.mutation(api.draftJobs.create, {
        ...createArgs, machineId: undefined, newMachine: { ...newMachine, slug },
      })).rejects.toMatchObject({ data: 'Invalid machine slug' });
    },
  );

  test('rejects existing procedure and machine slugs', async () => {
    const { author, createArgs } = await setup();
    await expect(author.mutation(api.draftJobs.create, { ...createArgs, procedureSlug: 'procedure' }))
      .rejects.toMatchObject({ data: 'Slug already used' });
    await expect(author.mutation(api.draftJobs.create, {
      ...createArgs, machineId: undefined, newMachine: { ...newMachine, slug: 'machine' },
    })).rejects.toMatchObject({ data: 'Slug already used' });
  });

  test.each(['queued', 'running'] as const)('rejects another job in a %s workspace', async (status) => {
    const { t, author, otherAuthor, createArgs } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    if (status === 'running') await t.mutation(api.draftJobs.claim, worker);
    await expect(otherAuthor.mutation(api.draftJobs.create, { ...createArgs, procedureSlug: 'another' }))
      .rejects.toMatchObject({ data: 'A job is already running for this machine' });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status });
  });

  test('queues a new machine workspace and reserves it until cancellation', async () => {
    const { t, author, authorId, createArgs } = await setup();
    const args = { ...createArgs, machineId: undefined, newMachine };
    const jobId = await author.mutation(api.draftJobs.create, args);
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      newMachine, kind: 'create', status: 'queued', stage: 'queued', attempts: 0,
      requestedBy: authorId, workspaceKey: newMachine.slug, updatedAt: expect.any(Number),
    });
    await expect(author.mutation(api.draftJobs.create, args))
      .rejects.toMatchObject({ data: 'A job is already running for this machine' });
    await author.mutation(api.draftJobs.cancel, { jobId });
    await expect(author.mutation(api.draftJobs.create, args)).resolves.toEqual(expect.any(String));
  });

  test.each(['signed out', 'trainee'] as const)('rejects author functions for %s', async (role) => {
    const { t, author, trainee, createArgs, versionId } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    const client = role === 'signed out' ? t : trainee;
    const data = role === 'signed out' ? 'Not signed in' : 'Not authorized';
    await expect(client.mutation(api.draftJobs.create, createArgs)).rejects.toMatchObject({ data });
    await expect(client.mutation(api.draftJobs.createRevision, {
      procedureVersionId: versionId, instruction: 'Revise',
    })).rejects.toMatchObject({ data });
    await expect(client.query(api.draftJobs.listMine, {})).rejects.toMatchObject({ data });
    await expect(client.query(api.draftJobs.list, {})).rejects.toMatchObject({ data });
    await expect(client.query(api.draftJobs.get, { jobId })).rejects.toMatchObject({ data });
    await expect(client.query(api.draftJobs.events, { jobId })).rejects.toMatchObject({ data });
    await expect(client.mutation(api.draftJobs.cancel, { jobId })).rejects.toMatchObject({ data });
    await expect(client.mutation(api.draftJobs.retry, { jobId })).rejects.toMatchObject({ data });
  });
});

describe('draftJobs.createRevision', () => {
  test('rejects approved versions and blank instructions', async () => {
    const { author, approver, versionId } = await setup();
    await expect(author.mutation(api.draftJobs.createRevision, {
      procedureVersionId: versionId, instruction: ' \t\n ',
    })).rejects.toMatchObject({ data: 'Instruction is required' });
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Reviewed' });
    await expect(author.mutation(api.draftJobs.createRevision, {
      procedureVersionId: versionId, instruction: 'Revise',
    })).rejects.toMatchObject({ data: 'Only drafts can be revised' });
  });

  test('snapshots the current draft, hash, video and pinned machine version', async () => {
    const { t, author, authorId, machineId, machineVersionId, versionId, videoFileId } = await setup();
    const content = emptyProcedureContent('Current title', definition);
    await author.mutation(api.procedures.saveDraft, { versionId, content });
    const jobId = await author.mutation(api.draftJobs.createRevision, {
      procedureVersionId: versionId, instruction: 'Clarify step one',
    });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      kind: 'revise', machineId, procedureSlug: 'procedure', title: 'Current title', brief: '',
      instruction: 'Clarify step one', targetProcedureVersionId: versionId,
      targetMachineVersionId: machineVersionId, sourceContentHash: contentHash(content),
      snapshotContent: content, videoFileId, workspaceKey: 'machine',
      status: 'queued', stage: 'queued', attempts: 0, requestedBy: authorId,
    });
  });

  test.each(['queued', 'running'] as const)('rejects a second revision of a %s target', async (status) => {
    const { t, author, otherAuthor, versionId } = await setup();
    const args = { procedureVersionId: versionId, instruction: 'Clarify' };
    await author.mutation(api.draftJobs.createRevision, args);
    if (status === 'running') await t.mutation(api.draftJobs.claim, worker);
    await expect(otherAuthor.mutation(api.draftJobs.createRevision, args))
      .rejects.toMatchObject({ data: 'A revision is already running for this draft' });
  });

  test('rejects revisions when another procedure job occupies the workspace', async () => {
    const { author, createArgs, versionId } = await setup();
    await author.mutation(api.draftJobs.create, createArgs);
    await expect(author.mutation(api.draftJobs.createRevision, {
      procedureVersionId: versionId, instruction: 'Clarify',
    })).rejects.toMatchObject({ data: 'A job is already running for this machine' });
  });
});

describe('draftJobs queries and access', () => {
  test('lists own jobs versus all jobs newest first and resolves machine slugs', async () => {
    const { author, otherAuthor, approver, createArgs } = await setup();
    const first = await author.mutation(api.draftJobs.create, createArgs);
    const second = await otherAuthor.mutation(api.draftJobs.create, {
      ...createArgs, machineId: undefined, newMachine,
    });
    const third = await author.mutation(api.draftJobs.create, {
      ...createArgs, machineId: undefined, newMachine: { ...newMachine, slug: 'third' },
    });
    const mine = await author.query(api.draftJobs.listMine, {});
    expect(mine.map((job) => job._id)).toEqual([third, first]);
    expect(mine.map((job) => job.machineSlug)).toEqual(['third', 'machine']);
    expect(mine[1]).toEqual({
      _id: first, kind: 'create', status: 'queued', stage: 'queued', title: createArgs.title,
      procedureSlug: createArgs.procedureSlug, machineSlug: 'machine', attempts: 0,
      _creationTime: expect.any(Number), updatedAt: expect.any(Number),
    });
    expect((await otherAuthor.query(api.draftJobs.listMine, {})).map((job) => job._id)).toEqual([second]);
    const all = await approver.query(api.draftJobs.list, {});
    expect(all.map((job) => job._id)).toEqual([third, second, first]);
    expect(all[1].machineSlug).toBe('new-machine');
    await expect(author.query(api.draftJobs.list, {})).rejects.toMatchObject({ data: 'Not authorized' });
  });

  test('caps the approver list at the newest 100 jobs', async () => {
    const { t, authorId, approver } = await setup();
    const ids = await t.run(async (ctx) => {
      const ids = [];
      for (let index = 0; index < 101; index++) {
        ids.push(await ctx.db.insert('draftJobs', {
          kind: 'create', status: 'done', stage: 'done', requestedBy: authorId,
          newMachine, workspaceKey: newMachine.slug, procedureSlug: `procedure-${index}`,
          title: 'Generated', brief: '', attempts: 1, updatedAt: index,
        }));
      }
      return ids;
    });
    expect((await approver.query(api.draftJobs.list, {})).map((job) => job._id))
      .toEqual(ids.slice(1).reverse());
  });

  test('allows owner and approver to get jobs and chronologically ordered events', async () => {
    const { t, author, otherAuthor, approver, admin, createArgs, machineId } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    const expectedEvents = [
      { at: 10, level: 'info' as const, message: 'First' },
      { at: 20, level: 'warn' as const, message: 'Second' },
    ];
    const unrelatedId = await otherAuthor.mutation(api.draftJobs.create, {
      ...createArgs, machineId: undefined, newMachine,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('jobEvents', { jobId, ...expectedEvents[1] });
      await ctx.db.insert('jobEvents', { jobId, ...expectedEvents[0] });
      await ctx.db.insert('jobEvents', { jobId: unrelatedId, at: 0, level: 'info', message: 'Other job' });
    });
    for (const client of [author, approver, admin]) {
      expect(await client.query(api.draftJobs.get, { jobId }))
        .toMatchObject({ _id: jobId, brief: createArgs.brief, machineId, machineSlug: 'machine' });
      expect(await client.query(api.draftJobs.events, { jobId })).toEqual(expectedEvents);
    }
    await expect(otherAuthor.query(api.draftJobs.get, { jobId }))
      .rejects.toMatchObject({ data: 'Not authorized' });
    await expect(otherAuthor.query(api.draftJobs.events, { jobId }))
      .rejects.toMatchObject({ data: 'Not authorized' });
  });
});

describe('draftJobs.cancel and retry', () => {
  test.each(['queued', 'running'] as const)('cancels a %s job as owner or approver', async (status) => {
    const { t, author, otherAuthor, approver, createArgs } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    if (status === 'running') await t.mutation(api.draftJobs.claim, worker);
    await expect(otherAuthor.mutation(api.draftJobs.cancel, { jobId }))
      .rejects.toMatchObject({ data: 'Not authorized' });
    const client = status === 'queued' ? author : approver;
    expect(await client.mutation(api.draftJobs.cancel, { jobId })).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status: 'cancelled' });
  });

  test.each(['failed', 'done', 'cancelled'] as const)('rejects cancellation from %s', async (status) => {
    const { t, author, createArgs } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.run((ctx) => ctx.db.patch(jobId, { status }));
    await expect(author.mutation(api.draftJobs.cancel, { jobId }))
      .rejects.toMatchObject({ data: 'Job is not active' });
  });

  test.each(['owner', 'approver'])('retries a failed job as %s and clears lease ownership and errors', async (role) => {
    const { t, author, otherAuthor, approver, createArgs } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.mutation(api.draftJobs.claim, worker);
    await t.mutation(api.draftJobs.setStage, { jobId, workerId: worker.workerId, stage: 'generating' });
    await t.mutation(api.draftJobs.fail, { jobId, workerId: worker.workerId, error: 'Worker failed' });
    // A retry must also clean up a legacy failed job that retained its lease timestamp.
    await t.run((ctx) => ctx.db.patch(jobId, { leaseUntil: Date.now() + 60_000 }));
    await expect(otherAuthor.mutation(api.draftJobs.retry, { jobId }))
      .rejects.toMatchObject({ data: 'Not authorized' });
    const client = role === 'owner' ? author : approver;
    expect(await client.mutation(api.draftJobs.retry, { jobId })).toBeNull();
    const retried = await t.run((ctx) => ctx.db.get(jobId));
    expect(retried).toMatchObject({ status: 'queued', stage: 'generating', attempts: 1 });
    for (const field of ['lastError', 'workerId', 'leaseUntil']) expect(retried).not.toHaveProperty(field);
    await expect(t.mutation(api.draftJobs.heartbeat, { jobId, workerId: worker.workerId }))
      .rejects.toMatchObject({ data: 'Lease lost' });
  });

  test.each(['queued', 'running', 'done', 'cancelled'] as const)('rejects retry from %s', async (status) => {
    const { t, author, createArgs } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.run((ctx) => ctx.db.patch(jobId, { status }));
    await expect(author.mutation(api.draftJobs.retry, { jobId }))
      .rejects.toMatchObject({ data: 'Only failed jobs can be retried' });
  });

  test('does not retry into an occupied workspace', async () => {
    const { t, author, createArgs } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.run((ctx) => ctx.db.patch(jobId, { status: 'failed' }));
    await author.mutation(api.draftJobs.create, { ...createArgs, procedureSlug: 'another' });
    await expect(author.mutation(api.draftJobs.retry, { jobId }))
      .rejects.toMatchObject({ data: 'A job is already running for this machine' });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status: 'failed' });
  });
});

describe('draftJobs worker lifecycle', () => {
  test('returns null when there is no queued job or expired running lease', async () => {
    const { t, author, createArgs } = await setup();
    expect(await t.mutation(api.draftJobs.claim, worker)).toBeNull();
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.mutation(api.draftJobs.claim, worker);
    expect(await t.mutation(api.draftJobs.claim, worker)).toBeNull();
    await author.mutation(api.draftJobs.cancel, { jobId });
    await t.run((ctx) => ctx.db.patch(jobId, { leaseUntil: Date.now() - 1 }));
    expect(await t.mutation(api.draftJobs.claim, worker)).toBeNull();
  });

  test('claims the oldest queued job and returns model, source, video and approved procedures', async () => {
    const {
      t, author, approver, createArgs, versionId, machineId, machineVersionId,
      modelFileId, sourceFileId, videoFileId,
    } = await setup();
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Reviewed' });
    await author.mutation(api.procedures.create, { machineId, slug: 'draft-only', title: 'Private draft' });
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    const nextId = await author.mutation(api.draftJobs.create, { ...createArgs, machineId: undefined, newMachine });
    const urls = await t.run(async (ctx) => ({
      modelUrl: await ctx.storage.getUrl(modelFileId),
      sourceUrl: await ctx.storage.getUrl(sourceFileId),
      videoUrl: await ctx.storage.getUrl(videoFileId),
    }));
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(await t.mutation(api.draftJobs.claim, worker)).toEqual({
      jobId, kind: 'create', stage: 'claimed', attempts: 1, workspaceKey: 'machine',
      machine: {
        slug: 'machine', name: 'Machine', kind: 'instrument', machineId,
        current: { machineVersionId, version: 1, definition, modelUrl: urls.modelUrl, sourceUrl: urls.sourceUrl },
      },
      procedureSlug: createArgs.procedureSlug, title: createArgs.title, brief: createArgs.brief,
      videoUrl: urls.videoUrl, approvedProcedures: [{ slug: 'procedure', content: emptyProcedureContent('Procedure', definition) }],
      leaseSeconds: 60,
    });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      status: 'running', stage: 'claimed', workerId: worker.workerId, leaseSeconds: 60,
      leaseUntil: 1_060_000, heartbeatAt: 1_000_000, attempts: 1, updatedAt: 1_000_000,
    });
    expect(await t.mutation(api.draftJobs.claim, worker)).toMatchObject({
      jobId: nextId, machine: newMachine, approvedProcedures: [],
    });
    expect(await t.mutation(api.draftJobs.claim, worker)).toBeNull();
  });

  test('keeps the revision target separate from a newer current machine version', async () => {
    const { t, admin, author, versionId, machineVersionId, publishArgs, modelFileId } = await setup();
    const newer = await admin.mutation(api.machines.publishVersion, publishArgs);
    const jobId = await author.mutation(api.draftJobs.createRevision, {
      procedureVersionId: versionId, instruction: 'Clarify the first step',
    });
    const content = emptyProcedureContent('Procedure', definition);
    const result = await t.mutation(api.draftJobs.claim, worker);
    expect(result).toMatchObject({
      jobId, kind: 'revise', instruction: 'Clarify the first step',
      machine: { current: { machineVersionId: newer.machineVersionId, version: 2 } },
      target: {
        procedureVersionId: versionId, machineVersionId, content, definition,
        contentHash: contentHash(content), modelUrl: await t.run((ctx) => ctx.storage.getUrl(modelFileId)),
      },
    });
  });

  test('prioritizes queued jobs, then reclaims expired leases oldest first and preserves progress', async () => {
    const { t, author, createArgs } = await setup();
    const firstId = await author.mutation(api.draftJobs.create, createArgs);
    await t.mutation(api.draftJobs.claim, worker);
    await t.mutation(api.draftJobs.setStage, {
      jobId: firstId, workerId: worker.workerId, stage: 'modeling', codexSessionId: 'session-1',
    });
    const secondId = await author.mutation(api.draftJobs.create, {
      ...createArgs, machineId: undefined, newMachine,
    });
    await t.mutation(api.draftJobs.claim, worker);
    await t.run(async (ctx) => {
      await ctx.db.patch(firstId, { leaseUntil: 1 });
      await ctx.db.patch(secondId, { leaseUntil: 1 });
    });
    const queuedId = await author.mutation(api.draftJobs.create, {
      ...createArgs, machineId: undefined, newMachine: { ...newMachine, slug: 'third' },
    });
    const replacement = { workerId: 'worker-2', leaseSeconds: 120 };
    expect(await t.mutation(api.draftJobs.claim, replacement)).toMatchObject({ jobId: queuedId, attempts: 1 });
    expect(await t.mutation(api.draftJobs.claim, replacement)).toMatchObject({
      jobId: firstId, attempts: 2, stage: 'modeling', codexSessionId: 'session-1', leaseSeconds: 120,
    });
    expect(await t.mutation(api.draftJobs.claim, replacement)).toMatchObject({ jobId: secondId, attempts: 2 });
    await expect(t.mutation(api.draftJobs.heartbeat, { jobId: firstId, workerId: worker.workerId }))
      .rejects.toMatchObject({ data: 'Lease lost' });
    expect(await t.mutation(api.draftJobs.claim, replacement)).toBeNull();
  });

  test.each([60, undefined])('heartbeat extends by the stored duration %s or the 300-second default', async (leaseSeconds) => {
    const { t, author, createArgs } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.mutation(api.draftJobs.claim, worker);
    await t.run((ctx) => ctx.db.patch(jobId, { leaseSeconds }));
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    expect(await t.mutation(api.draftJobs.heartbeat, { jobId, workerId: worker.workerId }))
      .toEqual({ status: 'running' });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      heartbeatAt: 2_000_000, leaseUntil: 2_000_000 + (leaseSeconds ?? 300) * 1000,
    });
    await author.mutation(api.draftJobs.cancel, { jobId });
    const cancelled = await t.run((ctx) => ctx.db.get(jobId));
    vi.mocked(Date.now).mockReturnValue(2_010_000);
    expect(await t.mutation(api.draftJobs.heartbeat, { jobId, workerId: worker.workerId }))
      .toEqual({ status: 'cancelled' });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toEqual(cancelled);
  });

  test('records progress and errors and preserves a session when only the stage changes', async () => {
    const { t, author, createArgs } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.mutation(api.draftJobs.claim, worker);
    const lease = { jobId, workerId: worker.workerId };
    expect(await t.mutation(api.draftJobs.setStage, {
      ...lease, stage: 'modeling', codexSessionId: 'session-1',
    })).toBeNull();
    await t.mutation(api.draftJobs.setStage, { ...lease, stage: 'writing' });
    expect(await t.run((ctx) => ctx.db.get(jobId)))
      .toMatchObject({ stage: 'writing', codexSessionId: 'session-1' });
    expect(await t.mutation(api.draftJobs.appendEvent, { ...lease, level: 'info', message: 'Started writing' })).toBeNull();
    expect(await t.mutation(api.draftJobs.fail, { ...lease, error: 'Generation failed' })).toBeNull();
    const failed = await t.run((ctx) => ctx.db.get(jobId));
    expect(failed).toMatchObject({ status: 'failed', lastError: 'Generation failed' });
    expect(failed).not.toHaveProperty('leaseUntil');
    expect(await author.query(api.draftJobs.events, { jobId })).toEqual([
      { at: expect.any(Number), level: 'info', message: 'Started writing' },
      { at: failed!.updatedAt, level: 'error', message: 'Generation failed' },
    ]);
  });

  test('rejects a mismatched worker for every lease-protected operation without changes', async () => {
    const { t, author, createArgs } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.mutation(api.draftJobs.claim, worker);
    const before = await t.run((ctx) => ctx.db.get(jobId));
    const lease = { jobId, workerId: 'wrong-worker' };
    await expect(t.mutation(api.draftJobs.heartbeat, lease)).rejects.toMatchObject({ data: 'Lease lost' });
    await expect(t.mutation(api.draftJobs.appendEvent, { ...lease, level: 'error', message: 'Wrong worker' }))
      .rejects.toMatchObject({ data: 'Lease lost' });
    await expect(t.mutation(api.draftJobs.setStage, { ...lease, stage: 'wrong-stage', codexSessionId: 'wrong-session' }))
      .rejects.toMatchObject({ data: 'Lease lost' });
    await expect(t.mutation(api.draftJobs.fail, { ...lease, error: 'Wrong worker' }))
      .rejects.toMatchObject({ data: 'Lease lost' });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toEqual(before);
    expect(await author.query(api.draftJobs.events, { jobId })).toEqual([]);
  });
});

describe('draftJobs.deliver', () => {
  test('delivers a new machine and procedure as drafts, then publishes them on approval', async () => {
    const { t, author, authorId, approver, createArgs, videoFileId } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, {
      ...createArgs, machineId: undefined, newMachine,
    });
    await t.mutation(api.draftJobs.claim, worker);
    await t.mutation(api.draftJobs.appendEvent, {
      jobId, workerId: worker.workerId, level: 'info', message: 'Ready to deliver',
    });
    const modelFileId = await t.run((ctx) => ctx.storage.store(new Blob(['x'])));
    const sourceFileId = await t.run((ctx) => ctx.storage.store(new Blob(['x'])));
    const content = emptyProcedureContent('From video', templateDefinition);
    const result = await t.mutation(api.draftJobs.deliver, {
      jobId, workerId: worker.workerId, modelChanged: true,
      model: { modelFileId, sourceFileId, definition: templateDefinition },
      procedure: { content }, mediaFileIds: [], report: { summary: 'Finished' },
    });
    const machineVersion = await t.run((ctx) => ctx.db.get(result.machineVersionId));
    expect(machineVersion).toMatchObject({
      status: 'draft', version: 1, modelFileId, sourceFileId, definition: templateDefinition,
    });
    const machine = await t.run((ctx) => ctx.db.get(machineVersion!.machineId));
    expect(machine).toMatchObject(newMachine);
    expect(machine).not.toHaveProperty('currentVersionId');
    const draft = await t.run((ctx) => ctx.db.get(result.procedureVersionId));
    expect(draft).toMatchObject({
      status: 'draft', version: 1, machineVersionId: result.machineVersionId,
      content, createdBy: authorId, sourceVideoFileId: videoFileId, contentRevision: 1,
      changeNote: 'Drafted from video',
    });
    expect(await t.run((ctx) => ctx.db.get(draft!.procedureId))).toMatchObject({
      machineId: machine!._id, slug: createArgs.procedureSlug,
    });
    const job = await t.run((ctx) => ctx.db.get(jobId));
    expect(job).toMatchObject({
      status: 'done', stage: 'done', modelChanged: true,
      producedMachineVersionId: result.machineVersionId,
      producedProcedureVersionId: result.procedureVersionId, updatedAt: expect.any(Number),
    });
    expect(job).not.toHaveProperty('workerId');
    expect(job).not.toHaveProperty('leaseUntil');
    expect(await author.query(api.draftJobs.events, { jobId })).toEqual([
      { at: expect.any(Number), level: 'info', message: 'Ready to deliver' },
      {
        at: job!.updatedAt, level: 'info',
        message: `Delivered: created draft machine version ${result.machineVersionId}; procedure version ${result.procedureVersionId}`,
      },
    ]);

    expect(await author.query(api.machines.getBySlug, { slug: newMachine.slug })).toBeNull();
    await expect(approver.mutation(api.procedures.approve, {
      versionId: result.procedureVersionId, changeNote: 'Reviewed video draft',
    })).resolves.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(result.procedureVersionId)))
      .toMatchObject({ status: 'approved', changeNote: 'Reviewed video draft' });
    expect(await t.run((ctx) => ctx.db.get(result.machineVersionId)))
      .toMatchObject({ status: 'published' });
    expect(await t.run((ctx) => ctx.db.get(machine!._id)))
      .toMatchObject({ currentVersionId: result.machineVersionId });
    expect(await author.query(api.machines.getBySlug, { slug: newMachine.slug }))
      .toMatchObject({ _id: machine!._id, version: { _id: result.machineVersionId } });
  });

  test('reuses the current machine version when the model did not change', async () => {
    const { t, author, createArgs, machineId, machineVersionId } = await setup(templateDefinition);
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.mutation(api.draftJobs.claim, worker);
    const before = await author.query(api.machines.listVersions, { machineId });
    const result = await t.mutation(api.draftJobs.deliver, {
      jobId, workerId: worker.workerId, modelChanged: false,
      procedure: { content: emptyProcedureContent('From video', templateDefinition) }, report: {},
    });
    expect(result.machineVersionId).toBe(machineVersionId);
    expect(await author.query(api.machines.listVersions, { machineId })).toEqual(before);
    expect(await t.run((ctx) => ctx.db.get(result.procedureVersionId))).toMatchObject({ machineVersionId });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      status: 'done', modelChanged: false, producedMachineVersionId: machineVersionId,
    });
    expect(await author.query(api.draftJobs.events, { jobId })).toEqual([{
      at: expect.any(Number), level: 'info',
      message: `Delivered: reused machine version ${machineVersionId}; procedure version ${result.procedureVersionId}`,
    }]);
  });

  test.each([
    {
      missing: 'missing part "body"',
      changed: { ...templateDefinition, parts: templateDefinition.parts.slice(1) },
    },
    {
      missing: 'missing state var "doorOpen", missing clip "doorOpen"',
      changed: { ...templateDefinition, stateVars: [] },
    },
    {
      missing: 'missing clip "doorOpen"',
      changed: {
        ...templateDefinition,
        stateVars: [{
          ...templateDefinition.stateVars[0],
          effects: [{ type: 'visible' as const, node: 'door' }],
        }],
      },
    },
  ])('rejects non-additive changes ($missing) without writing anything', async ({ changed, missing }) => {
    const { t, author, createArgs, machineId, modelFileId } = await setup(templateDefinition);
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.mutation(api.draftJobs.claim, worker);
    const beforeJob = await t.run((ctx) => ctx.db.get(jobId));
    const beforeVersions = await author.query(api.machines.listVersions, { machineId });
    await expect(t.mutation(api.draftJobs.deliver, {
      jobId, workerId: worker.workerId, modelChanged: true,
      model: { modelFileId, definition: changed },
      procedure: { content: emptyProcedureContent('From video', changed) }, report: {},
    })).rejects.toMatchObject({ data: `Model change is not additive: ${missing}` });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toEqual(beforeJob);
    expect(await author.query(api.machines.listVersions, { machineId })).toEqual(beforeVersions);
    expect(await t.run((ctx) => ctx.db.query('procedures')
      .withIndex('by_machine_slug', (q) => q.eq('machineId', machineId).eq('slug', createArgs.procedureSlug))
      .unique())).toBeNull();
    expect(await author.query(api.draftJobs.events, { jobId })).toEqual([]);
  });

  test('names an approved procedure whose older pinned model still contains a removed part', async () => {
    const { t, admin, author, approver, createArgs, versionId, publishArgs } = await setup(templateDefinition);
    const approvedContent = emptyProcedureContent('Approved', templateDefinition);
    approvedContent.steps[0].parts = ['body', 'body'];
    await author.mutation(api.procedures.saveDraft, { versionId, content: approvedContent });
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Reviewed' });
    // This historical approval remains pinned to the older, complete definition.
    const changed = { ...templateDefinition, parts: templateDefinition.parts.slice(1) };
    await admin.mutation(api.machines.publishVersion, { ...publishArgs, definition: changed });
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.mutation(api.draftJobs.claim, worker);
    await expect(t.mutation(api.draftJobs.deliver, {
      jobId, workerId: worker.workerId, modelChanged: true,
      model: { modelFileId: publishArgs.modelFileId, definition: changed },
      procedure: { content: emptyProcedureContent('From video', changed) }, report: {},
    })).rejects.toMatchObject({
      data: 'Approved procedure "procedure" breaks on the new model: steps[0].parts[0]: Unknown part "body".; steps[0].parts[1]: Unknown part "body".',
    });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status: 'running' });
    expect(await author.query(api.machines.listVersions, { machineId: createArgs.machineId })).toHaveLength(2);
  });

  test('allows new state variables missing only from approved start states, but requires them in delivery', async () => {
    const { t, author, approver, createArgs, versionId, machineVersionId, modelFileId } = await setup(templateDefinition);
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Reviewed' });
    const approved = await t.run((ctx) => ctx.db.get(versionId));
    const changed: MachineDefinition = {
      ...templateDefinition,
      stateVars: [...templateDefinition.stateVars, {
        name: 'powerOn', label: 'Power on', kind: 'toggle',
        effects: [{ type: 'visible', node: 'panel' }],
      }],
    };
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.mutation(api.draftJobs.claim, worker);
    const args = {
      jobId, workerId: worker.workerId, modelChanged: true,
      model: { modelFileId, definition: changed }, report: {},
    };
    await expect(t.mutation(api.draftJobs.deliver, {
      ...args, procedure: { content: emptyProcedureContent('Incomplete', templateDefinition) },
    })).rejects.toMatchObject({ data: 'Invalid procedure: start.powerOn: Missing initial state for "powerOn".' });
    const result = await t.mutation(api.draftJobs.deliver, {
      ...args, procedure: { content: emptyProcedureContent('Complete', changed) },
    });
    expect(result.machineVersionId).not.toBe(machineVersionId);
    expect(await t.run((ctx) => ctx.db.get(result.machineVersionId))).toMatchObject({ status: 'draft' });
    expect(await t.run((ctx) => ctx.db.get(createArgs.machineId))).toMatchObject({ currentVersionId: machineVersionId });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toEqual(approved);
  });

  test('rejects unknown delivered parts and rolls back the newly inserted machine and model', async () => {
    const { t, author, createArgs, modelFileId } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, {
      ...createArgs, machineId: undefined, newMachine,
    });
    await t.mutation(api.draftJobs.claim, worker);
    const before = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      machines: await ctx.db.query('machines').collect(),
      models: await ctx.db.query('machineVersions').collect(),
      procedures: await ctx.db.query('procedures').collect(),
      versions: await ctx.db.query('procedureVersions').collect(),
    }));
    const content = emptyProcedureContent('Invalid', templateDefinition);
    content.steps[0].parts = ['unknown-part'];
    await expect(t.mutation(api.draftJobs.deliver, {
      jobId, workerId: worker.workerId, modelChanged: true,
      model: { modelFileId, definition: templateDefinition }, procedure: { content }, report: {},
    })).rejects.toMatchObject({ data: 'Invalid procedure: steps[0].parts[0]: Unknown part "unknown-part".' });
    expect(await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      machines: await ctx.db.query('machines').collect(),
      models: await ctx.db.query('machineVersions').collect(),
      procedures: await ctx.db.query('procedures').collect(),
      versions: await ctx.db.query('procedureVersions').collect(),
    }))).toEqual(before);
    expect(await author.query(api.draftJobs.events, { jobId })).toEqual([]);
  });

  test('checks approved links against delivered step ids and revises the target onto a draft model', async () => {
    const { t, author, approver, versionId, procedureId, machineId, machineVersionId, modelFileId } = await setup(templateDefinition);
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Reviewed' });
    const linked = await author.mutation(api.procedures.create, { machineId, slug: 'linked', title: 'Linked' });
    const linkedContent = emptyProcedureContent('Linked', templateDefinition);
    linkedContent.steps[0].link = { procedureSlug: 'procedure', stepId: 'step-1', label: 'Original step' };
    await author.mutation(api.procedures.saveDraft, { versionId: linked.versionId, content: linkedContent });
    await approver.mutation(api.procedures.approve, { versionId: linked.versionId, changeNote: 'Reviewed' });
    const targetId = await author.mutation(api.procedures.createDraft, { procedureId });
    const jobId = await author.mutation(api.draftJobs.createRevision, {
      procedureVersionId: targetId, instruction: 'Add a step and update the model',
    });
    await t.mutation(api.draftJobs.claim, worker);
    const content = emptyProcedureContent('Revised', templateDefinition);
    content.steps[0].id = 'replacement';
    content.steps[0].link = { procedureSlug: 'procedure', stepId: 'replacement', label: 'Self' };
    const args = {
      jobId, workerId: worker.workerId, modelChanged: true,
      model: { modelFileId, definition: templateDefinition }, report: {},
    };
    await expect(t.mutation(api.draftJobs.deliver, { ...args, procedure: { content } }))
      .rejects.toMatchObject({
        data: 'Approved procedure "linked" breaks on the new model: steps[0].link.stepId: Unknown step "step-1" in procedure "procedure".',
      });
    // Keep the incoming approved link valid, and also link out to an approved procedure.
    content.steps.push({
      ...content.steps[0], id: 'step-1',
      link: { procedureSlug: 'linked', stepId: 'step-1', label: 'Related procedure' },
    });
    const result = await t.mutation(api.draftJobs.deliver, { ...args, procedure: { content } });
    expect(result.procedureVersionId).toBe(targetId);
    expect(result.machineVersionId).not.toBe(machineVersionId);
    expect(await t.run((ctx) => ctx.db.get(result.machineVersionId))).toMatchObject({ status: 'draft' });
    expect(await t.run((ctx) => ctx.db.get(targetId))).toMatchObject({
      content, contentRevision: 1, machineVersionId: result.machineVersionId, version: 2,
    });
    expect(await t.run((ctx) => ctx.db.get(machineId))).toMatchObject({ currentVersionId: machineVersionId });
    expect(await t.run((ctx) => ctx.db.query('procedureVersions')
      .withIndex('by_procedure', (q) => q.eq('procedureId', procedureId)).collect())).toHaveLength(2);
  });

  test.each([
    { procedureSlug: 'procedure', stepId: 'missing', issue: 'stepId: Unknown step "missing" in procedure "procedure".' },
    { procedureSlug: 'draft-only', stepId: 'step-1', issue: 'procedureSlug: Unknown linked procedure "draft-only".' },
    { procedureSlug: 'from-video', stepId: 'missing', issue: 'stepId: Unknown step "missing" in procedure "from-video".' },
  ])('rejects invalid delivered links to $procedureSlug/$stepId', async ({ procedureSlug, stepId, issue }) => {
    const { t, author, approver, versionId, machineId, createArgs } = await setup(templateDefinition);
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Reviewed' });
    await author.mutation(api.procedures.create, { machineId, slug: 'draft-only', title: 'Draft only' });
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.mutation(api.draftJobs.claim, worker);
    const content = emptyProcedureContent('From video', templateDefinition);
    content.steps[0].link = { procedureSlug, stepId, label: 'Invalid link' };
    await expect(t.mutation(api.draftJobs.deliver, {
      jobId, workerId: worker.workerId, modelChanged: false, procedure: { content }, report: {},
    })).rejects.toMatchObject({ data: `Invalid procedure: steps[0].link.${issue}` });
  });

  test('rejects a changed revision target using the stored hash and rolls back the model', async () => {
    const { t, author, versionId, machineId, modelFileId } = await setup(templateDefinition);
    const jobId = await author.mutation(api.draftJobs.createRevision, {
      procedureVersionId: versionId, instruction: 'Clarify',
    });
    await t.mutation(api.draftJobs.claim, worker);
    const edited = emptyProcedureContent('Changed elsewhere', templateDefinition);
    await t.run((ctx) => ctx.db.patch(versionId, { content: edited }));
    const before = await t.run((ctx) => ctx.db.get(versionId));
    const beforeJob = await t.run((ctx) => ctx.db.get(jobId));
    const beforeVersions = await author.query(api.machines.listVersions, { machineId });
    await expect(t.mutation(api.draftJobs.deliver, {
      jobId, workerId: worker.workerId, modelChanged: true,
      model: { modelFileId, definition: templateDefinition },
      sourceContentHash: contentHash(edited),
      procedure: { content: emptyProcedureContent('Revised', templateDefinition) }, report: {},
    })).rejects.toMatchObject({ data: 'Draft changed during revision' });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toEqual(before);
    expect(await t.run((ctx) => ctx.db.get(jobId))).toEqual(beforeJob);
    expect(await author.query(api.machines.listVersions, { machineId })).toEqual(beforeVersions);
  });

  test.each([undefined, 4])('patches a matching revision at contentRevision %s and reuses its pinned model', async (revision) => {
    const { t, admin, author, versionId, machineVersionId, publishArgs } = await setup(templateDefinition);
    await t.run((ctx) => ctx.db.patch(versionId, { contentRevision: revision }));
    const original = await t.run((ctx) => ctx.db.get(versionId));
    // The current model no longer fits this draft; delivery must use the target's pin.
    const newer = await admin.mutation(api.machines.publishVersion, {
      ...publishArgs, definition: { ...templateDefinition, parts: [] },
    });
    const jobId = await author.mutation(api.draftJobs.createRevision, {
      procedureVersionId: versionId, instruction: 'Clarify',
    });
    await t.mutation(api.draftJobs.claim, worker);
    const content = emptyProcedureContent('Revised', templateDefinition);
    content.steps[0].parts = ['body'];
    expect(await t.mutation(api.draftJobs.deliver, {
      jobId, workerId: worker.workerId, modelChanged: false, procedure: { content }, report: {},
    })).toEqual({ procedureVersionId: versionId, machineVersionId });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toEqual({
      ...original, content, contentRevision: (revision ?? 0) + 1,
    });
    expect(await t.run((ctx) => ctx.db.query('procedureVersions')
      .withIndex('by_procedure', (q) => q.eq('procedureId', original!.procedureId)).collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.get(newer.machineId))).toMatchObject({ currentVersionId: newer.machineVersionId });
  });

  test.each(['deleted', 'approved'] as const)('rejects a revision whose target was %s', async (status) => {
    const { t, author, approver, versionId } = await setup(templateDefinition);
    const jobId = await author.mutation(api.draftJobs.createRevision, {
      procedureVersionId: versionId, instruction: 'Clarify',
    });
    await t.mutation(api.draftJobs.claim, worker);
    if (status === 'deleted') await author.mutation(api.procedures.discardDraft, { versionId });
    else await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Reviewed' });
    await expect(t.mutation(api.draftJobs.deliver, {
      jobId, workerId: worker.workerId, modelChanged: false,
      procedure: { content: emptyProcedureContent('Revised', templateDefinition) }, report: {},
    })).rejects.toMatchObject({ data: 'Target draft no longer exists' });
  });

  test('rejects a worker with the wrong lease without changes', async () => {
    const { t, author, createArgs } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.mutation(api.draftJobs.claim, worker);
    const before = await t.run((ctx) => ctx.db.get(jobId));
    await expect(t.mutation(api.draftJobs.deliver, {
      jobId, workerId: 'wrong-worker', modelChanged: true, procedure: { content: {} }, report: {},
    })).rejects.toMatchObject({ data: 'Lease lost' });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toEqual(before);
    expect(await author.query(api.draftJobs.events, { jobId })).toEqual([]);
  });

  test.each(['queued', 'failed', 'done', 'cancelled'] as const)('rejects delivery from %s even with a matching worker', async (status) => {
    const { t, author, createArgs } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.mutation(api.draftJobs.claim, worker);
    await t.run((ctx) => ctx.db.patch(jobId, { status }));
    await expect(t.mutation(api.draftJobs.deliver, {
      jobId, workerId: worker.workerId, modelChanged: true, procedure: { content: {} }, report: {},
    })).rejects.toMatchObject({ data: 'Job is not running' });
  });

  test.each([true, false])('requires a model for a new machine (modelChanged: %s)', async (modelChanged) => {
    const { t, author, createArgs } = await setup();
    const jobId = await author.mutation(api.draftJobs.create, {
      ...createArgs, machineId: undefined, newMachine,
    });
    await t.mutation(api.draftJobs.claim, worker);
    await expect(t.mutation(api.draftJobs.deliver, {
      jobId, workerId: worker.workerId, modelChanged,
      procedure: { content: emptyProcedureContent('From video', templateDefinition) }, report: {},
    })).rejects.toMatchObject({
      data: modelChanged ? 'Model files are required when the model changed' : 'A new machine needs a model',
    });
  });

  test.each([false, true])('reuses an existing procedure from a partial create (hasDraft: %s)', async (hasDraft) => {
    const { t, author, approver, createArgs, machineId, machineVersionId } = await setup(templateDefinition);
    const jobId = await author.mutation(api.draftJobs.create, createArgs);
    await t.mutation(api.draftJobs.claim, worker);
    const partial = await author.mutation(api.procedures.create, {
      machineId, slug: createArgs.procedureSlug, title: 'Partial',
    });
    if (hasDraft) await t.run((ctx) => ctx.db.patch(partial.versionId, { contentRevision: 3 }));
    else await approver.mutation(api.procedures.approve, { versionId: partial.versionId, changeNote: 'Earlier version' });
    const content = emptyProcedureContent('Finished', templateDefinition);
    const result = await t.mutation(api.draftJobs.deliver, {
      jobId, workerId: worker.workerId, modelChanged: false, procedure: { content }, report: {},
    });
    if (hasDraft) expect(result.procedureVersionId).toBe(partial.versionId);
    else expect(result.procedureVersionId).not.toBe(partial.versionId);
    expect(await t.run((ctx) => ctx.db.get(result.procedureVersionId))).toMatchObject({
      procedureId: partial.procedureId, content, machineVersionId,
      version: hasDraft ? 1 : 2, contentRevision: hasDraft ? 4 : 1,
    });
    expect(await t.run((ctx) => ctx.db.query('procedureVersions')
      .withIndex('by_procedure', (q) => q.eq('procedureId', partial.procedureId)).collect()))
      .toHaveLength(hasDraft ? 1 : 2);
  });
});

import { anyApi } from 'convex/server';
import type { ApiFromModules } from 'convex/server';
import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { describe, expect, test } from 'vitest';
import type { MachineDefinition } from '../shared/machine';
import type * as files from './files';
import type * as machines from './machines';
import type * as procedures from './procedures';
import type * as training from './training';
import schema from './schema';
import { asUser, createUser, modules } from './test.setup';

const api = anyApi as unknown as ApiFromModules<{
  files: typeof files;
  machines: typeof machines;
  procedures: typeof procedures;
  training: typeof training;
}>;

const definition: MachineDefinition = {
  formatVersion: 1, rootNode: 'instrument', parts: [], presetViews: [], stateVars: [],
};

async function setup() {
  const t = convexTest(schema, modules);
  const adminId = await createUser(t, { email: 'admin@example.com', role: 'admin' });
  const approverId = await createUser(t, {
    email: 'approver@example.com', name: 'Reviewer', role: 'approver',
  });
  const traineeId = await createUser(t, {
    email: 'trainee@example.com', name: 'Trainee', role: 'trainee',
  });
  const admin = asUser(t, adminId);
  const approver = asUser(t, approverId);
  const trainee = asUser(t, traineeId);
  const modelFileId = await t.run((ctx) => ctx.storage.store(new Blob(['model'])));
  const { machineId } = await admin.mutation(api.machines.publishVersion, {
    slug: 'machine', name: 'Machine', kind: 'instrument', modelFileId, definition,
  });
  const { procedureId, versionId } = await admin.mutation(api.procedures.create, {
    machineId, slug: 'procedure', title: 'Original title',
  });
  return { t, admin, approver, approverId, trainee, traineeId, procedureId, versionId, modelFileId };
}

async function setupApproved() {
  const fixture = await setup();
  await fixture.approver.mutation(api.procedures.approve, {
    versionId: fixture.versionId, changeNote: 'Initial',
  });
  return fixture;
}

describe('training.complete', () => {
  test('rejects a draft version', async () => {
    const { t, trainee, versionId } = await setup();
    const completion = trainee.mutation(api.training.complete, {
      procedureVersionId: versionId, checkpoints: [],
    });
    await expect(completion).rejects.toBeInstanceOf(ConvexError);
    await expect(completion).rejects.toMatchObject({ data: 'Only approved procedures are recorded' });
    expect(await t.run((ctx) => ctx.db.query('trainingRecords').collect())).toEqual([]);
  });

  test('records completion of a version retired by a newer approval', async () => {
    const { t, admin, approver, trainee, traineeId, procedureId, versionId } = await setupApproved();
    const nextId = await admin.mutation(api.procedures.createDraft, { procedureId });
    await approver.mutation(api.procedures.approve, { versionId: nextId, changeNote: 'Next' });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toMatchObject({ status: 'retired' });

    const checkpoints = [{ stepId: 'step-1', at: 123 }];
    const before = Date.now();
    const recordId = await trainee.mutation(api.training.complete, {
      procedureVersionId: versionId, checkpoints,
    });
    const record = await t.run((ctx) => ctx.db.get(recordId));
    expect(record).toMatchObject({ userId: traineeId, procedureVersionId: versionId, selfAttestedCheckpoints: checkpoints });
    expect(record!.completedAt).toBeGreaterThanOrEqual(before);
    expect(record!.completedAt).toBeLessThanOrEqual(Date.now());
  });

  test('records self-declared checkpoints and stays pinned after a newer approval', async () => {
    const { t, admin, approver, trainee, traineeId, procedureId, versionId } = await setupApproved();
    const checkpoints = [{ stepId: 'step-1', at: 123 }];
    const before = Date.now();
    const recordId = await trainee.mutation(api.training.complete, {
      procedureVersionId: versionId, checkpoints,
    });
    const record = await t.run((ctx) => ctx.db.get(recordId));
    expect(record).toMatchObject({ userId: traineeId, procedureVersionId: versionId, selfAttestedCheckpoints: checkpoints });
    expect(record!.completedAt).toBeGreaterThanOrEqual(before);
    expect(record!.completedAt).toBeLessThanOrEqual(Date.now());
    expect(record).not.toHaveProperty('signedOffAt');
    expect(record).not.toHaveProperty('signedOffBy');

    const nextId = await admin.mutation(api.procedures.createDraft, { procedureId });
    const next = await admin.query(api.procedures.getVersion, { versionId: nextId });
    await admin.mutation(api.procedures.saveDraft, {
      versionId: nextId, content: { ...next.content, title: 'New title' },
    });
    await approver.mutation(api.procedures.approve, { versionId: nextId, changeNote: 'Next' });
    expect(await t.run((ctx) => ctx.db.get(recordId))).toEqual(record);
    expect(await trainee.query(api.training.listMine, {})).toEqual([{
      _id: recordId, completedAt: record!.completedAt, checkpointCount: 1,
      procedureTitle: 'Original title', procedureSlug: 'procedure',
      machineSlug: 'machine', machineName: 'Machine', version: 1,
    }]);
  });

  test('keeps only the first checkpoint for each step in submitted order', async () => {
    const { t, admin, approver, trainee, versionId } = await setup();
    const draft = await admin.query(api.procedures.getVersion, { versionId });
    const content = draft.content;
    content.steps.push({ ...content.steps[0], id: 'step-2' });
    await admin.mutation(api.procedures.saveDraft, { versionId, content });
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Two steps' });
    const checkpoints = [
      { stepId: 'step-2', at: 123 },
      { stepId: 'step-1', at: 456 },
      { stepId: 'step-2', at: 789 },
      { stepId: 'step-1', at: 1000 },
    ];

    const recordId = await trainee.mutation(api.training.complete, {
      procedureVersionId: versionId, checkpoints,
    });
    const record = await t.run((ctx) => ctx.db.get(recordId));
    expect(record!.selfAttestedCheckpoints).toEqual([checkpoints[0], checkpoints[1]]);
  });

  test('rejects too many distinct checkpoints without inserting a record', async () => {
    const { t, trainee, versionId } = await setupApproved();
    const completion = trainee.mutation(api.training.complete, {
      procedureVersionId: versionId,
      checkpoints: [{ stepId: 'step-1', at: 1 }, { stepId: 'extra-step', at: 2 }],
    });
    await expect(completion).rejects.toBeInstanceOf(ConvexError);
    await expect(completion).rejects.toMatchObject({ data: 'Too many checkpoints' });
    expect(await t.run((ctx) => ctx.db.query('trainingRecords').collect())).toEqual([]);
  });

  test('clamps future checkpoint timestamps to the completion time', async () => {
    const { t, trainee, versionId } = await setupApproved();
    const before = Date.now();
    const future = before + 100000;
    const recordId = await trainee.mutation(api.training.complete, {
      procedureVersionId: versionId, checkpoints: [{ stepId: 'step-1', at: future }],
    });
    const record = await t.run((ctx) => ctx.db.get(recordId));
    expect(record!.selfAttestedCheckpoints).toEqual([{ stepId: 'step-1', at: record!.completedAt }]);
    expect(record!.completedAt).toBeGreaterThanOrEqual(before);
    expect(record!.completedAt).toBeLessThanOrEqual(Date.now());
    expect(record!.selfAttestedCheckpoints[0].at).toBeLessThan(future);
  });

  test('rejects an unknown checkpoint without inserting a record', async () => {
    const { t, trainee, versionId } = await setupApproved();
    await expect(trainee.mutation(api.training.complete, {
      procedureVersionId: versionId,
      checkpoints: [{ stepId: 'missing', at: 2 }],
    })).rejects.toMatchObject({ data: 'Unknown checkpoint step: missing' });
    expect(await t.run((ctx) => ctx.db.query('trainingRecords').collect())).toEqual([]);
  });

  test('requires sign-in for completion and both lists', async () => {
    const { t, versionId } = await setupApproved();
    await expect(t.mutation(api.training.complete, { procedureVersionId: versionId, checkpoints: [] }))
      .rejects.toMatchObject({ data: 'Not signed in' });
    await expect(t.query(api.training.listMine, {})).rejects.toMatchObject({ data: 'Not signed in' });
    await expect(t.query(api.training.listAll, {})).rejects.toMatchObject({ data: 'Not signed in' });
  });
});

describe('training lists', () => {
  test('limits mine to the caller and returns all records newest first for an approver', async () => {
    const { t, approver, approverId, trainee, traineeId, versionId } = await setupApproved();
    const args = { procedureVersionId: versionId, checkpoints: [] };
    const first = await trainee.mutation(api.training.complete, args);
    const other = await approver.mutation(api.training.complete, args);
    const last = await trainee.mutation(api.training.complete, args);
    await t.run(async (ctx) => {
      await ctx.db.patch(first, { completedAt: 100 });
      await ctx.db.patch(other, { completedAt: 300 });
      await ctx.db.patch(last, { completedAt: 200 });
    });
    expect((await trainee.query(api.training.listMine, {})).map((record) => record._id))
      .toEqual([last, first]);
    await expect(trainee.query(api.training.listAll, {})).rejects.toMatchObject({ data: 'Not authorized' });
    const all = await approver.query(api.training.listAll, {});
    expect(all.map((record) => record._id)).toEqual([other, last, first]);
    expect(all[0]).toMatchObject({ userId: approverId, userName: 'Reviewer', userEmail: 'approver@example.com' });
    expect(all[1]).toMatchObject({ userId: traineeId, userName: 'Trainee', userEmail: 'trainee@example.com' });
  });
});

describe('training.signOff', () => {
  test('rejects an approver signing their own record', async () => {
    const { approver, versionId } = await setupApproved();
    const recordId = await approver.mutation(api.training.complete, { procedureVersionId: versionId, checkpoints: [] });
    await expect(approver.mutation(api.training.signOff, { recordId }))
      .rejects.toMatchObject({ data: 'You cannot sign off your own record' });
  });

  test('requires an approver, records a separate sign-off, and rejects a second sign-off', async () => {
    const { t, admin, approver, approverId, trainee, versionId } = await setupApproved();
    const recordId = await trainee.mutation(api.training.complete, { procedureVersionId: versionId, checkpoints: [] });
    await expect(trainee.mutation(api.training.signOff, { recordId }))
      .rejects.toMatchObject({ data: 'Not authorized' });
    await expect(t.mutation(api.training.signOff, { recordId }))
      .rejects.toMatchObject({ data: 'Not signed in' });
    const before = Date.now();
    expect(await approver.mutation(api.training.signOff, { recordId, note: 'Observed in person' })).toBeNull();
    const signed = await t.run((ctx) => ctx.db.get(recordId));
    expect(signed).toMatchObject({ signedOffBy: approverId, signOffNote: 'Observed in person' });
    expect(signed!.signedOffAt).toBeGreaterThanOrEqual(before);
    expect(signed!.signedOffAt).toBeLessThanOrEqual(Date.now());
    expect((await trainee.query(api.training.listMine, {}))[0]).toMatchObject({
      signedOffAt: signed!.signedOffAt, signedOffByName: 'Reviewer',
    });
    await expect(admin.mutation(api.training.signOff, { recordId, note: 'Overwrite' }))
      .rejects.toMatchObject({ data: 'Record already signed off' });
    expect(await t.run((ctx) => ctx.db.get(recordId))).toEqual(signed);
  });
});

describe('file access', () => {
  test('requires admin for models and author or higher for media', async () => {
    const { t, admin, approver, trainee } = await setup();
    const authorId = await createUser(t, { email: 'author@example.com', role: 'author' });
    const author = asUser(t, authorId);
    for (const client of [trainee, author, approver]) {
      await expect(client.mutation(api.files.generateUploadUrl, { kind: 'model' }))
        .rejects.toMatchObject({ data: 'Not authorized' });
    }
    await expect(trainee.mutation(api.files.generateUploadUrl, { kind: 'media' }))
      .rejects.toMatchObject({ data: 'Not authorized' });
    await expect(t.mutation(api.files.generateUploadUrl, { kind: 'media' }))
      .rejects.toMatchObject({ data: 'Not signed in' });
    expect(await admin.mutation(api.files.generateUploadUrl, { kind: 'model' })).toEqual(expect.any(String));
    for (const client of [author, approver, admin]) {
      expect(await client.mutation(api.files.generateUploadUrl, { kind: 'media' })).toEqual(expect.any(String));
    }
  });

  test('requires sign-in for URLs and returns null for deleted files', async () => {
    const { t, admin, modelFileId } = await setup();
    await expect(t.query(api.files.mediaUrl, { fileId: modelFileId }))
      .rejects.toMatchObject({ data: 'Not signed in' });
    expect(await admin.query(api.files.mediaUrl, { fileId: modelFileId })).toEqual(expect.any(String));
    await t.run((ctx) => ctx.storage.delete(modelFileId));
    expect(await admin.query(api.files.mediaUrl, { fileId: modelFileId })).toBeNull();
  });
});

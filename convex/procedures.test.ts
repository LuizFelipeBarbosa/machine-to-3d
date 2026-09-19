import { anyApi } from 'convex/server';
import type { ApiFromModules } from 'convex/server';
import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { describe, expect, test } from 'vitest';
import type { MachineDefinition } from '../shared/machine';
import type { ProcedureContent } from '../shared/procedure';
import type * as draftJobs from './draftJobs';
import { emptyProcedureContent, parseContent, parseDefinition, publishMachineVersion } from './lib/content';
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
  parts: [
    { name: 'head', label: 'Head', blurb: '' },
    { name: 'sample', label: 'Sample', blurb: '' },
  ],
  presetViews: [{
    name: 'front', label: 'Front', view: { pos: [1, 2, 3], target: [0, 0, 0] },
  }],
  stateVars: [{
    name: 'lift', label: 'Lift', kind: 'toggle',
    effects: [{ type: 'translate', node: 'head', offset: [0, 0.3, 0] }],
  }],
};

async function setup() {
  const t = convexTest(schema, modules);
  const adminId = await createUser(t, { email: 'admin@example.com', role: 'admin' });
  const authorId = await createUser(t, { email: 'author@example.com', role: 'author' });
  const approverId = await createUser(t, { email: 'approver@example.com', role: 'approver' });
  const traineeId = await createUser(t, { email: 'trainee@example.com', role: 'trainee' });
  const admin = asUser(t, adminId);
  const author = asUser(t, authorId);
  const modelFileId = await t.run((ctx) => ctx.storage.store(new Blob(['x'])));
  const publishArgs = { slug: 'machine', name: 'Machine', kind: 'instrument', modelFileId, definition };
  const machine = await admin.mutation(api.machines.publishVersion, publishArgs);
  const procedure = await author.mutation(api.procedures.create, {
    machineId: machine.machineId, slug: 'procedure', title: 'Procedure',
  });
  return {
    t, admin, author, authorId, approverId,
    approver: asUser(t, approverId),
    trainee: asUser(t, traineeId),
    publishArgs,
    ...machine,
    ...procedure,
  };
}

describe('procedure content', () => {
  test('uses all initial state variables and the first preset, or the default camera', () => {
    const content = emptyProcedureContent('Title', definition);
    expect(content).toEqual({
      formatVersion: 1, title: 'Title', summary: '', minutes: 10, start: { lift: false },
      steps: [{
        id: 'step-1', title: 'First step', where: 'instrument', body: '', parts: [],
        view: definition.presetViews[0].view,
      }],
    });
    const noPresets = emptyProcedureContent('Title', { ...definition, presetViews: [] });
    expect(noPresets.steps[0].view).toEqual({ pos: [0, 0, 10], target: [0, 0, 0] });
    expect(parseContent(noPresets)).toEqual(noPresets);
  });

  test('wraps the first Zod issue in a string ConvexError', () => {
    const invalidContent = { ...emptyProcedureContent('Title', definition), title: '', minutes: 0 };
    expect(() => parseContent(invalidContent)).toThrow(ConvexError);
    expect(() => parseContent(invalidContent)).toThrow('Invalid procedure content: title:');
    expect(() => parseDefinition({ ...definition, rootNode: '' })).toThrow(ConvexError);
    expect(() => parseDefinition({ ...definition, rootNode: '' }))
      .toThrow('Invalid machine definition: rootNode:');
  });
});

describe('procedures.create and saveDraft', () => {
  test('refuses saves while an agent revision targets the draft and unlocks after cancellation', async () => {
    const { t, author, versionId } = await setup();
    const before = await t.run((ctx) => ctx.db.get(versionId));
    const jobId = await author.mutation(api.draftJobs.createRevision, {
      procedureVersionId: versionId, instruction: 'Clarify the first step',
    });
    const content = emptyProcedureContent('Edited', definition);
    for (const status of ['queued', 'running'] as const) {
      await t.run((ctx) => ctx.db.patch(jobId, { status }));
      await expect(author.mutation(api.procedures.saveDraft, { versionId, content }))
        .rejects.toMatchObject({ data: 'An agent revision is running for this draft' });
      expect(await t.run((ctx) => ctx.db.get(versionId))).toEqual(before);
    }
    await author.mutation(api.draftJobs.cancel, { jobId });
    expect(await author.mutation(api.procedures.saveDraft, { versionId, content })).toBeNull();
  });

  test('creates draft v1 pinned to the current machine and records its author', async () => {
    const { t, authorId, machineVersionId, procedureId, versionId } = await setup();
    expect(await t.run((ctx) => ctx.db.get(procedureId))).toMatchObject({ slug: 'procedure' });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toMatchObject({
      procedureId, version: 1, status: 'draft', machineVersionId, createdBy: authorId,
      content: emptyProcedureContent('Procedure', definition),
    });
  });

  test.each(['', 'Uppercase', 'has space', 'under_score', 'slash/name'])(
    'rejects invalid slug %j', async (slug) => {
      const { author, machineId } = await setup();
      await expect(author.mutation(api.procedures.create, { machineId, slug, title: 'Title' }))
        .rejects.toMatchObject({ data: 'Invalid procedure slug' });
    },
  );

  test('enforces slug uniqueness within a machine', async () => {
    const { admin, author, machineId, publishArgs } = await setup();
    await expect(author.mutation(api.procedures.create, {
      machineId, slug: 'procedure', title: 'Duplicate',
    })).rejects.toMatchObject({ data: 'Slug already used' });
    const otherMachine = await admin.mutation(api.machines.publishVersion, {
      ...publishArgs, slug: 'other-machine',
    });
    await expect(author.mutation(api.procedures.create, {
      machineId: otherMachine.machineId, slug: 'procedure', title: 'Allowed',
    })).resolves.toMatchObject({ procedureId: expect.any(String) });
  });

  test('requires a current machine version and a valid title without leaving an empty procedure', async () => {
    const { t, author, machineId } = await setup();
    await expect(author.mutation(api.procedures.create, { machineId, slug: 'bad-title', title: '' }))
      .rejects.toMatchObject({ data: expect.stringContaining('Invalid procedure content: title:') });
    const emptyMachineId = await t.run((ctx) => ctx.db.insert('machines', {
      slug: 'empty', name: 'Empty', kind: 'test',
    }));
    await expect(author.mutation(api.procedures.create, {
      machineId: emptyMachineId, slug: 'procedure', title: 'Title',
    })).rejects.toMatchObject({ data: 'Machine version not found' });
    expect(await t.run((ctx) => ctx.db.query('procedures').collect())).toHaveLength(1);
  });

  test('saves structurally valid drafts even with unresolved references', async () => {
    const { t, author, versionId } = await setup();
    const content = emptyProcedureContent('Edited', definition);
    content.steps[0].parts = ['unknown-part'];
    content.start = {};
    expect(await author.mutation(api.procedures.saveDraft, { versionId, content })).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(versionId))).toMatchObject({ status: 'draft', content });
  });

  test('checks the content revision only when provided and never increments it on save', async () => {
    const { t, author, versionId } = await setup();
    await t.run((ctx) => ctx.db.patch(versionId, { contentRevision: 2 }));
    const before = await t.run((ctx) => ctx.db.get(versionId));
    const content = emptyProcedureContent('Edited', definition);
    await expect(author.mutation(api.procedures.saveDraft, {
      versionId, content, expectedContentRevision: 1,
    })).rejects.toMatchObject({ data: 'Draft was changed elsewhere; reload before saving' });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toEqual(before);
    expect(await author.query(api.procedures.getVersion, { versionId }))
      .toMatchObject({ contentRevision: 2 });

    expect(await author.mutation(api.procedures.saveDraft, {
      versionId, content, expectedContentRevision: 2,
    })).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(versionId))).toMatchObject({ content, contentRevision: 2 });

    const nextContent = { ...content, title: 'Saved without a revision check' };
    expect(await author.mutation(api.procedures.saveDraft, { versionId, content: nextContent })).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(versionId)))
      .toMatchObject({ content: nextContent, contentRevision: 2 });
  });

  test('treats an absent content revision as zero when saving', async () => {
    const { t, author, versionId } = await setup();
    const content = emptyProcedureContent('Edited', definition);
    expect(await author.mutation(api.procedures.saveDraft, {
      versionId, content, expectedContentRevision: 0,
    })).toBeNull();
    const version = await t.run((ctx) => ctx.db.get(versionId));
    expect(version).toMatchObject({ content });
    expect(version).not.toHaveProperty('contentRevision');
  });

  test.each([0, -1, 1.5])('rejects invalid minutes %s without changing content', async (minutes) => {
    const { t, author, versionId } = await setup();
    const before = await t.run((ctx) => ctx.db.get(versionId));
    await expect(author.mutation(api.procedures.saveDraft, {
      versionId, content: { ...emptyProcedureContent('Edited', definition), minutes },
    })).rejects.toMatchObject({ data: expect.stringContaining('Invalid procedure content: minutes:') });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toEqual(before);
  });
});

describe('procedure version lifecycle', () => {
  test('approves v1, copies v2, retires v1, and copies retired v1 into draft v3', async () => {
    const { t, author, authorId, approver, approverId, procedureId, versionId, machineVersionId } = await setup();
    const firstContent = emptyProcedureContent('First revision', definition);
    firstContent.steps[0].parts = ['head', 'sample'];
    await author.mutation(api.procedures.saveDraft, { versionId, content: firstContent });
    expect(await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Initial approval' })).toBeNull();
    const firstApproved = await t.run((ctx) => ctx.db.get(versionId));
    expect(firstApproved).toMatchObject({
      status: 'approved', approvedBy: approverId, approvedAt: expect.any(Number),
      changeNote: 'Initial approval', content: firstContent,
    });
    expect(await t.run((ctx) => ctx.db.get(procedureId))).toMatchObject({ approvedVersionId: versionId });

    const secondId = await author.mutation(api.procedures.createDraft, { procedureId });
    expect(await t.run((ctx) => ctx.db.get(secondId))).toMatchObject({
      version: 2, status: 'draft', content: firstContent, machineVersionId,
      copiedFromVersionId: versionId, createdBy: authorId,
    });
    const secondDraft = await t.run((ctx) => ctx.db.get(secondId));
    expect(secondDraft).not.toHaveProperty('approvedAt');
    expect(secondDraft).not.toHaveProperty('approvedBy');
    expect(secondDraft).not.toHaveProperty('changeNote');
    const secondContent = { ...firstContent, title: 'Second revision', minutes: 20 };
    await author.mutation(api.procedures.saveDraft, { versionId: secondId, content: secondContent });
    await approver.mutation(api.procedures.approve, { versionId: secondId, changeNote: 'Revision two' });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toEqual({ ...firstApproved, status: 'retired' });
    expect(await t.run((ctx) => ctx.db.get(secondId))).toMatchObject({ status: 'approved', content: secondContent });
    expect(await t.run((ctx) => ctx.db.get(procedureId))).toMatchObject({ approvedVersionId: secondId });

    const thirdId = await author.mutation(api.procedures.createDraft, { procedureId, fromVersionId: versionId });
    expect(await t.run((ctx) => ctx.db.get(thirdId))).toMatchObject({
      version: 3, status: 'draft', content: firstContent, copiedFromVersionId: versionId,
    });
    expect(await author.query(api.procedures.listVersions, { procedureId })).toEqual([
      { _id: thirdId, version: 3, status: 'draft', _creationTime: expect.any(Number), copiedFromVersionId: versionId },
      {
        _id: secondId, version: 2, status: 'approved', _creationTime: expect.any(Number),
        copiedFromVersionId: versionId, approvedAt: expect.any(Number), changeNote: 'Revision two',
      },
      {
        _id: versionId, version: 1, status: 'retired', _creationTime: expect.any(Number),
        approvedAt: expect.any(Number), changeNote: 'Initial approval',
      },
    ]);
  });

  test.each(['approved', 'retired'] as const)('prevents editing, deleting, or approving a %s version', async (status) => {
    const { t, author, approver, procedureId, versionId } = await setup();
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Original' });
    if (status === 'retired') {
      const nextId = await author.mutation(api.procedures.createDraft, { procedureId });
      await approver.mutation(api.procedures.approve, { versionId: nextId, changeNote: 'Replacement' });
    }
    const before = await t.run((ctx) => ctx.db.get(versionId));
    const procedureBefore = await t.run((ctx) => ctx.db.get(procedureId));
    await expect(author.mutation(api.procedures.saveDraft, {
      versionId, content: emptyProcedureContent('Forbidden edit', definition),
    })).rejects.toMatchObject({ data: 'Only drafts can be edited' });
    await expect(author.mutation(api.procedures.discardDraft, { versionId }))
      .rejects.toMatchObject({ data: 'Only drafts can be discarded' });
    await expect(approver.mutation(api.procedures.approve, { versionId, changeNote: 'Repeated' }))
      .rejects.toMatchObject({ data: 'Only drafts can be approved' });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toEqual(before);
    expect(await t.run((ctx) => ctx.db.get(procedureId))).toEqual(procedureBefore);
  });

  test('rejects a second draft regardless of the requested source', async () => {
    const { t, author, procedureId, versionId } = await setup();
    await expect(author.mutation(api.procedures.createDraft, { procedureId }))
      .rejects.toMatchObject({ data: 'A draft already exists' });
    await expect(author.mutation(api.procedures.createDraft, { procedureId, fromVersionId: versionId }))
      .rejects.toMatchObject({ data: 'A draft already exists' });
    expect(await t.run((ctx) => ctx.db.query('procedureVersions').collect())).toHaveLength(1);
  });

  test('rejects source versions from another procedure', async () => {
    const { t, author, approver, machineId, procedureId, versionId } = await setup();
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Initial approval' });
    const other = await author.mutation(api.procedures.create, { machineId, slug: 'other', title: 'Other' });
    await expect(author.mutation(api.procedures.createDraft, { procedureId, fromVersionId: other.versionId }))
      .rejects.toMatchObject({ data: 'Source version belongs to another procedure' });
    expect(await t.run((ctx) => ctx.db.query('procedureVersions').collect())).toHaveLength(2);
  });

  test('falls back to the latest version when no version is approved', async () => {
    const { t, author, procedureId, versionId } = await setup();
    await t.run((ctx) => ctx.db.patch(versionId, { status: 'retired' }));
    const nextId = await author.mutation(api.procedures.createDraft, { procedureId });
    expect(await t.run((ctx) => ctx.db.get(nextId))).toMatchObject({
      version: 2, status: 'draft', copiedFromVersionId: versionId,
      content: emptyProcedureContent('Procedure', definition),
    });
  });

  test.each(['published', undefined] as const)('preserves pins with machine status %s while new drafts target current', async (status) => {
    const { t, admin, author, approver, trainee, procedureId, versionId, machineVersionId, publishArgs } = await setup();
    await t.run((ctx) => ctx.db.patch(machineVersionId, { status }));
    const content = emptyProcedureContent('Uses sample', definition);
    content.steps[0].parts = ['sample'];
    await author.mutation(api.procedures.saveDraft, { versionId, content });
    const nextDefinition = { ...definition, parts: [definition.parts[0]] };
    const modelFileId = await t.run((ctx) => ctx.storage.store(new Blob(['new model'])));
    const current = await admin.mutation(api.machines.publishVersion, {
      ...publishArgs, definition: nextDefinition, modelFileId,
    });
    // Approval validates the pinned definition even when the current model changed.
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Pinned v1' });
    expect(await t.run((ctx) => ctx.db.get(current.machineId))).toMatchObject({
      currentVersionId: current.machineVersionId,
    });
    const playback = await trainee.query(api.procedures.getForPlay, {
      machineSlug: 'machine', procedureSlug: 'procedure',
    });
    expect(playback).toMatchObject({
      versionId, machineVersionId, content, definition,
      modelUrl: await t.run((ctx) => ctx.storage.getUrl(publishArgs.modelFileId)),
    });

    const draftId = await author.mutation(api.procedures.createDraft, { procedureId });
    expect(await author.query(api.procedures.getVersion, { versionId: draftId })).toMatchObject({
      machineVersionId: current.machineVersionId, definition: nextDefinition, content,
      modelUrl: await t.run((ctx) => ctx.storage.getUrl(modelFileId)),
    });
    await expect(approver.mutation(api.procedures.approve, { versionId: draftId, changeNote: 'Updated machine' }))
      .rejects.toMatchObject({ data: expect.stringContaining('steps[0].parts[0]: Unknown part "sample".') });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toMatchObject({ status: 'approved', machineVersionId });
  });
});

describe('procedures.createDraft machine version pins', () => {
  test.each(['explicit', 'latest'])('keeps a newer draft machine version from the %s source', async (source) => {
    const { t, author, machineId, machineVersionId, procedureId, versionId, publishArgs } = await setup();
    const draftMachine = await t.run((ctx) => publishMachineVersion(ctx, { ...publishArgs, publish: false }));
    await t.run((ctx) => ctx.db.patch(versionId, {
      status: 'retired', machineVersionId: draftMachine.machineVersionId,
    }));
    const draftId = await author.mutation(api.procedures.createDraft, {
      procedureId, ...(source === 'explicit' ? { fromVersionId: versionId } : {}),
    });
    expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject({
      version: 2, status: 'draft', machineVersionId: draftMachine.machineVersionId,
      copiedFromVersionId: versionId, content: emptyProcedureContent('Procedure', definition),
    });
    expect(await t.run((ctx) => ctx.db.get(machineId))).toMatchObject({ currentVersionId: machineVersionId });
    expect(await t.run((ctx) => ctx.db.get(draftMachine.machineVersionId))).toMatchObject({ status: 'draft' });
  });

  test('falls back to the current machine when the source draft has been superseded', async () => {
    const { t, admin, author, procedureId, versionId, publishArgs } = await setup();
    const draftMachine = await t.run((ctx) => publishMachineVersion(ctx, { ...publishArgs, publish: false }));
    await t.run((ctx) => ctx.db.patch(versionId, {
      status: 'retired', machineVersionId: draftMachine.machineVersionId,
    }));
    const current = await admin.mutation(api.machines.publishVersion, publishArgs);
    const draftId = await author.mutation(api.procedures.createDraft, { procedureId, fromVersionId: versionId });
    expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject({
      machineVersionId: current.machineVersionId, copiedFromVersionId: versionId,
    });
  });

  test('keeps the newest draft machine version when the machine has no current version', async () => {
    const { t, author, machineId, machineVersionId, procedureId, versionId } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(machineId, { currentVersionId: undefined });
      await ctx.db.patch(machineVersionId, { status: 'draft' });
      await ctx.db.patch(versionId, { status: 'retired' });
    });
    const draftId = await author.mutation(api.procedures.createDraft, { procedureId });
    expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject({
      machineVersionId, copiedFromVersionId: versionId,
    });
    expect(await t.run((ctx) => ctx.db.get(machineId))).not.toHaveProperty('currentVersionId');
  });

  test.each(['draft', 'published'] as const)('rejects a source superseded by a %s version when there is no current version', async (status) => {
    const { t, author, machineId, machineVersionId, procedureId, versionId, publishArgs } = await setup();
    await t.run(async (ctx) => {
      await publishMachineVersion(ctx, { ...publishArgs, publish: status === 'published' });
      await ctx.db.patch(machineId, { currentVersionId: undefined });
      await ctx.db.patch(machineVersionId, { status: 'draft' });
      await ctx.db.patch(versionId, { status: 'retired' });
    });
    await expect(author.mutation(api.procedures.createDraft, { procedureId, fromVersionId: versionId }))
      .rejects.toMatchObject({ data: 'Machine version superseded' });
    expect(await author.query(api.procedures.listVersions, { procedureId })).toHaveLength(1);
  });

  test.each(['published', 'deleted'])('rejects a %s source pin when there is no current version', async (source) => {
    const { t, author, machineId, machineVersionId, procedureId, versionId } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(machineId, { currentVersionId: undefined });
      await ctx.db.patch(versionId, { status: 'retired' });
      if (source === 'deleted') {
        await ctx.db.delete(machineVersionId);
      }
    });
    await expect(author.mutation(api.procedures.createDraft, { procedureId }))
      .rejects.toMatchObject({ data: 'Machine version not found' });
    expect(await author.query(api.procedures.listVersions, { procedureId })).toHaveLength(1);
  });
});

describe('procedures.approve draft machine versions', () => {
  test.each([false, true])('publishes the pinned draft as an approver with an existing current version: %s', async (hasCurrent) => {
    const { t, approver, machineId, machineVersionId, procedureId, versionId, publishArgs } = await setup();
    if (!hasCurrent) {
      await t.run(async (ctx) => {
        await ctx.db.patch(machineId, { currentVersionId: undefined });
        await ctx.db.patch(machineVersionId, { status: 'draft' });
      });
    }
    const draftMachine = await t.run((ctx) => publishMachineVersion(ctx, { ...publishArgs, publish: false }));
    await t.run((ctx) => ctx.db.patch(versionId, { machineVersionId: draftMachine.machineVersionId }));
    expect(await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Generated model reviewed' }))
      .toBeNull();
    expect(await t.run((ctx) => ctx.db.get(draftMachine.machineVersionId))).toMatchObject({ status: 'published' });
    expect(await t.run((ctx) => ctx.db.get(machineId))).toMatchObject({
      currentVersionId: draftMachine.machineVersionId,
    });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toMatchObject({ status: 'approved' });
    expect(await t.run((ctx) => ctx.db.get(procedureId))).toMatchObject({ approvedVersionId: versionId });
  });

  test('rechecks additive compatibility against the current model when publishing a stale draft', async () => {
    const { t, author, approver, machineId, machineVersionId, procedureId, versionId, publishArgs } = await setup();
    const extraPart = { name: 'extra', label: 'Extra', blurb: '' };
    const withExtra = await t.run((ctx) => publishMachineVersion(ctx, {
      ...publishArgs, definition: { ...definition, parts: [...definition.parts, extraPart] }, publish: false,
    }));
    const withoutExtra = await t.run((ctx) => publishMachineVersion(ctx, {
      ...publishArgs, definition, publish: false,
    }));
    await t.run((ctx) => ctx.db.patch(versionId, { machineVersionId: withExtra.machineVersionId }));
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Extra part reviewed' });
    expect(await t.run((ctx) => ctx.db.get(machineId))).toMatchObject({
      currentVersionId: withExtra.machineVersionId,
    });

    const other = await author.mutation(api.procedures.create, {
      machineId, slug: 'other', title: 'Other',
    });
    await t.run((ctx) => ctx.db.patch(other.versionId, { machineVersionId: withoutExtra.machineVersionId }));
    const before = await t.run((ctx) => ctx.db.get(machineId));
    const error = await approver.mutation(api.procedures.approve, {
      versionId: other.versionId, changeNote: 'Stale model',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConvexError);
    expect(error).toMatchObject({
      data: expect.stringMatching(/^Model change is not additive:.*missing part "extra"/),
    });
    expect(await t.run((ctx) => ctx.db.get(machineId))).toMatchObject({
      currentVersionId: before!.currentVersionId,
    });
    expect(await t.run((ctx) => ctx.db.get(withoutExtra.machineVersionId))).toMatchObject({ status: 'draft' });
    expect(await t.run((ctx) => ctx.db.get(other.versionId))).toMatchObject({ status: 'draft' });
    expect(machineVersionId).not.toBe(withExtra.machineVersionId);
  });

  test('rejects a superseded draft machine without retiring the existing approval', async () => {
    const { t, admin, author, approver, machineId, procedureId, versionId, publishArgs } = await setup();
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Original' });
    const draftId = await author.mutation(api.procedures.createDraft, { procedureId });
    const draftMachine = await t.run((ctx) => publishMachineVersion(ctx, { ...publishArgs, publish: false }));
    await t.run((ctx) => ctx.db.patch(draftId, { machineVersionId: draftMachine.machineVersionId }));
    await admin.mutation(api.machines.publishVersion, publishArgs);
    const before = await t.run(async (ctx) => ({
      machine: await ctx.db.get(machineId),
      machineVersion: await ctx.db.get(draftMachine.machineVersionId),
      procedure: await ctx.db.get(procedureId),
      versions: await ctx.db.query('procedureVersions').collect(),
    }));
    await expect(approver.mutation(api.procedures.approve, { versionId: draftId, changeNote: 'Stale model' }))
      .rejects.toMatchObject({ data: 'Machine version superseded' });
    expect(await t.run(async (ctx) => ({
      machine: await ctx.db.get(machineId),
      machineVersion: await ctx.db.get(draftMachine.machineVersionId),
      procedure: await ctx.db.get(procedureId),
      versions: await ctx.db.query('procedureVersions').collect(),
    }))).toEqual(before);
  });

  test('validates the procedure before publishing the pinned draft machine', async () => {
    const { t, author, approver, machineId, machineVersionId, versionId, publishArgs } = await setup();
    const draftMachine = await t.run((ctx) => publishMachineVersion(ctx, { ...publishArgs, publish: false }));
    await t.run((ctx) => ctx.db.patch(versionId, { machineVersionId: draftMachine.machineVersionId }));
    const content = emptyProcedureContent('Invalid reference', definition);
    content.steps[0].parts = ['unknown'];
    await author.mutation(api.procedures.saveDraft, { versionId, content });
    await expect(approver.mutation(api.procedures.approve, { versionId, changeNote: 'Invalid' }))
      .rejects.toMatchObject({ data: expect.stringContaining('Invalid procedure references:') });
    expect(await t.run((ctx) => ctx.db.get(draftMachine.machineVersionId))).toMatchObject({ status: 'draft' });
    expect(await t.run((ctx) => ctx.db.get(machineId))).toMatchObject({ currentVersionId: machineVersionId });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toMatchObject({ status: 'draft' });
  });
});

describe('procedure approval validation', () => {
  test.each(['', ' \t\n '])('rejects a blank change note %j without changing state', async (changeNote) => {
    const { t, author, approver, procedureId, versionId } = await setup();
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Initial approval' });
    const draftId = await author.mutation(api.procedures.createDraft, { procedureId });
    const before = await t.run(async (ctx) => ({
      procedure: await ctx.db.get(procedureId),
      versions: await ctx.db.query('procedureVersions').collect(),
    }));

    const approval = approver.mutation(api.procedures.approve, { versionId: draftId, changeNote });
    await expect(approval).rejects.toBeInstanceOf(ConvexError);
    await expect(approval).rejects.toMatchObject({ data: 'A change note is required' });
    expect(await t.run(async (ctx) => ({
      procedure: await ctx.db.get(procedureId),
      versions: await ctx.db.query('procedureVersions').collect(),
    }))).toEqual(before);
  });

  test('retires every prior approval for the procedure, including an unreferenced version', async () => {
    const { t, author, approver, machineId, machineVersionId, procedureId, versionId } = await setup();
    const other = await author.mutation(api.procedures.create, { machineId, slug: 'other', title: 'Other' });
    await approver.mutation(api.procedures.approve, { versionId: other.versionId, changeNote: 'Other approval' });
    const otherBefore = await t.run((ctx) => ctx.db.get(other.versionId));
    const previousIds = await t.run(async (ctx) => {
      const content = emptyProcedureContent('Previous revision', definition);
      const firstId = await ctx.db.insert('procedureVersions', {
        procedureId, machineVersionId, content, version: 1, status: 'approved',
      });
      const secondId = await ctx.db.insert('procedureVersions', {
        procedureId, machineVersionId, content, version: 2, status: 'approved',
      });
      await ctx.db.patch(procedureId, { approvedVersionId: firstId });
      await ctx.db.patch(versionId, { version: 3 });
      return [firstId, secondId];
    });

    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'New approval' });
    for (const previousId of previousIds) {
      expect(await t.run((ctx) => ctx.db.get(previousId))).toMatchObject({ status: 'retired' });
    }
    expect(await t.run((ctx) => ctx.db.get(versionId))).toMatchObject({ status: 'approved' });
    expect(await t.run((ctx) => ctx.db.get(procedureId))).toMatchObject({ approvedVersionId: versionId });
    expect(await t.run((ctx) => ctx.db.get(other.versionId))).toEqual(otherBefore);
  });

  test('reports every reference issue and leaves the existing approval intact', async () => {
    const { t, author, approver, procedureId, versionId } = await setup();
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Original' });
    const approvedBefore = await t.run((ctx) => ctx.db.get(versionId));
    const draftId = await author.mutation(api.procedures.createDraft, { procedureId });
    const invalid = emptyProcedureContent('Invalid', definition);
    invalid.start = {};
    invalid.steps[0].parts = ['unknown'];
    await author.mutation(api.procedures.saveDraft, { versionId: draftId, content: invalid });
    const approval = approver.mutation(api.procedures.approve, { versionId: draftId, changeNote: 'Bad' });
    await expect(approval).rejects.toBeInstanceOf(ConvexError);
    await expect(approval).rejects.toMatchObject({
      data: 'Invalid procedure references:\nstart.lift: Missing initial state for "lift".\nsteps[0].parts[0]: Unknown part "unknown".',
    });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toEqual(approvedBefore);
    expect(await t.run((ctx) => ctx.db.get(procedureId))).toMatchObject({ approvedVersionId: versionId });
    expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject({ status: 'draft', content: invalid });
  });

  test('rejects a link to a draft-only procedure, then accepts its approved steps', async () => {
    const { author, approver, trainee, machineId, versionId } = await setup();
    const target = await author.mutation(api.procedures.create, { machineId, slug: 'target', title: 'Target' });
    const content = emptyProcedureContent('Linked', definition);
    content.steps[0].link = { procedureSlug: 'target', stepId: 'step-1', label: 'Go' };
    await author.mutation(api.procedures.saveDraft, { versionId, content });
    await expect(approver.mutation(api.procedures.approve, { versionId, changeNote: 'Link to target' }))
      .rejects.toMatchObject({ data: expect.stringContaining('steps[0].link.procedureSlug:') });
    await approver.mutation(api.procedures.approve, { versionId: target.versionId, changeNote: 'Target ready' });

    const targetDraftId = await author.mutation(api.procedures.createDraft, { procedureId: target.procedureId });
    const targetContent = emptyProcedureContent('Unapproved target revision', definition);
    targetContent.steps[0].id = 'draft-step';
    await author.mutation(api.procedures.saveDraft, { versionId: targetDraftId, content: targetContent });
    content.steps[0].link.stepId = 'draft-step';
    await author.mutation(api.procedures.saveDraft, { versionId, content });
    await expect(approver.mutation(api.procedures.approve, { versionId, changeNote: 'Link to draft step' }))
      .rejects.toMatchObject({ data: expect.stringContaining('steps[0].link.stepId:') });

    content.steps[0].link.stepId = 'step-1';
    await author.mutation(api.procedures.saveDraft, { versionId, content });
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Link to approved step' });
    expect(await trainee.query(api.procedures.getForPlay, {
      machineSlug: 'machine', procedureSlug: 'procedure',
    })).toMatchObject({ linkTargets: { procedure: ['step-1'], target: ['step-1'] } });
  });

  test('accepts self-links using the steps of the draft being approved', async () => {
    const { author, approver, procedureId, versionId } = await setup();
    const content = emptyProcedureContent('Self-link', definition);
    content.steps[0].link = { procedureSlug: 'procedure', stepId: 'step-1', label: 'Repeat' };
    await author.mutation(api.procedures.saveDraft, { versionId, content });
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Self-link' });
    const draftId = await author.mutation(api.procedures.createDraft, { procedureId });
    content.steps[0].id = 'replacement-step';
    content.steps[0].link.stepId = 'replacement-step';
    await author.mutation(api.procedures.saveDraft, { versionId: draftId, content });
    await expect(approver.mutation(api.procedures.approve, { versionId: draftId, changeNote: 'New step' }))
      .resolves.toBeNull();
  });

  test('does not resolve links using an approved procedure on another machine', async () => {
    const { admin, author, approver, versionId, publishArgs } = await setup();
    const otherMachine = await admin.mutation(api.machines.publishVersion, { ...publishArgs, slug: 'other-machine' });
    const target = await author.mutation(api.procedures.create, {
      machineId: otherMachine.machineId, slug: 'target', title: 'Target',
    });
    await approver.mutation(api.procedures.approve, { versionId: target.versionId, changeNote: 'Target ready' });
    const content = emptyProcedureContent('Cross-machine link', definition);
    content.steps[0].link = { procedureSlug: 'target', label: 'Go' };
    await author.mutation(api.procedures.saveDraft, { versionId, content });
    await expect(approver.mutation(api.procedures.approve, { versionId, changeNote: 'Cross-machine link' }))
      .rejects.toMatchObject({ data: expect.stringContaining('steps[0].link.procedureSlug:') });
  });
});

describe('procedure queries and authorization', () => {
  test('playback returns null without approval, and keeps serving approval while a draft exists', async () => {
    const { author, approver, trainee, procedureId, versionId } = await setup();
    const args = { machineSlug: 'machine', procedureSlug: 'procedure' };
    expect(await trainee.query(api.procedures.getForPlay, args)).toBeNull();
    expect(await author.query(api.procedures.getForPlay, args)).toBeNull();
    expect(await trainee.query(api.procedures.getForPlay, { ...args, machineSlug: 'missing' })).toBeNull();
    expect(await trainee.query(api.procedures.getForPlay, { ...args, procedureSlug: 'missing' })).toBeNull();
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Initial approval' });
    const draftId = await author.mutation(api.procedures.createDraft, { procedureId });
    await author.mutation(api.procedures.saveDraft, {
      versionId: draftId, content: emptyProcedureContent('Private draft', definition),
    });
    const approved = await trainee.query(api.procedures.getForPlay, args);
    expect(approved).toMatchObject({ procedureId, versionId, version: 1, content: { title: 'Procedure' } });
    // This assignment also checks that Zod parsing preserves tuple types in the API.
    const typedContent: ProcedureContent | undefined = approved?.content;
    expect(typedContent?.steps[0].view.pos).toEqual([1, 2, 3]);
    await approver.mutation(api.procedures.approve, { versionId: draftId, changeNote: 'Revised procedure' });
    expect(await trainee.query(api.procedures.getForPlay, args)).toMatchObject({ versionId: draftId, version: 2 });
  });

  test.each(['draft', 'retired'] as const)('never serves a %s version even through a stale approval pointer', async (status) => {
    const { t, trainee, procedureId, versionId } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(procedureId, { approvedVersionId: versionId });
      await ctx.db.patch(versionId, { status });
    });
    expect(await trainee.query(api.procedures.getForPlay, {
      machineSlug: 'machine', procedureSlug: 'procedure',
    })).toBeNull();
    expect((await trainee.query(api.machines.list, {}))[0].procedures).toEqual([]);
  });

  test('returns a complete draft to an author and rejects a trainee', async () => {
    const { author, authorId, trainee, procedureId, versionId, machineVersionId } = await setup();
    expect(await author.query(api.procedures.getVersion, { versionId })).toEqual({
      _id: versionId, procedureId, version: 1, status: 'draft', machineVersionId,
      content: emptyProcedureContent('Procedure', definition), createdBy: authorId,
      contentRevision: 0, sourceVideoUrl: null,
      modelUrl: expect.any(String), definition, linkTargets: { procedure: ['step-1'] }, mediaUrls: {},
      machineSlug: 'machine', procedureSlug: 'procedure',
    });
    await expect(trainee.query(api.procedures.getVersion, { versionId }))
      .rejects.toMatchObject({ data: 'Not authorized' });
  });

  test.each(['signed out', 'trainee', 'missing role'] as const)('rejects author operations for %s', async (role) => {
    const { t, trainee, machineId, procedureId, versionId } = await setup();
    const legacyId = await createUser(t, { email: 'legacy@example.com' });
    const client = role === 'signed out' ? t : role === 'trainee' ? trainee : asUser(t, legacyId);
    const data = role === 'signed out' ? 'Not signed in' : 'Not authorized';
    await expect(client.mutation(api.procedures.create, { machineId, slug: 'new', title: 'New' }))
      .rejects.toMatchObject({ data });
    await expect(client.mutation(api.procedures.createDraft, { procedureId }))
      .rejects.toMatchObject({ data });
    await expect(client.mutation(api.procedures.saveDraft, {
      versionId, content: emptyProcedureContent('Forbidden', definition),
    })).rejects.toMatchObject({ data });
    await expect(client.mutation(api.procedures.discardDraft, { versionId }))
      .rejects.toMatchObject({ data });
    await expect(client.mutation(api.procedures.approve, { versionId, changeNote: '' }))
      .rejects.toMatchObject({ data });
    await expect(client.query(api.procedures.getVersion, { versionId })).rejects.toMatchObject({ data });
    await expect(client.query(api.procedures.listVersions, { procedureId })).rejects.toMatchObject({ data });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toMatchObject({ status: 'draft' });
  });

  test('requires sign-in for playback and approver rank for approval', async () => {
    const { t, author, versionId } = await setup();
    await expect(t.query(api.procedures.getForPlay, { machineSlug: 'machine', procedureSlug: 'procedure' }))
      .rejects.toMatchObject({ data: 'Not signed in' });
    await expect(author.mutation(api.procedures.approve, { versionId, changeNote: '' }))
      .rejects.toMatchObject({ data: 'Not authorized' });
  });
});

describe('procedures.discardDraft', () => {
  test('deletes the only version and its procedure, freeing the slug', async () => {
    const { t, author, machineId, procedureId, versionId } = await setup();
    expect(await author.mutation(api.procedures.discardDraft, { versionId })).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(versionId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(procedureId))).toBeNull();
    await expect(author.mutation(api.procedures.create, { machineId, slug: 'procedure', title: 'Replacement' }))
      .resolves.toMatchObject({ procedureId: expect.any(String) });
    await expect(author.mutation(api.procedures.discardDraft, { versionId }))
      .rejects.toMatchObject({ data: 'Procedure version not found' });
  });

  test('preserves the procedure and approval when other versions remain', async () => {
    const { t, author, approver, procedureId, versionId } = await setup();
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Keep' });
    const before = await t.run((ctx) => ctx.db.get(versionId));
    const draftId = await author.mutation(api.procedures.createDraft, { procedureId });
    await author.mutation(api.procedures.discardDraft, { versionId: draftId });
    expect(await t.run((ctx) => ctx.db.get(draftId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(procedureId))).toMatchObject({ approvedVersionId: versionId });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toEqual(before);
    expect(await author.query(api.procedures.listVersions, { procedureId })).toHaveLength(1);
  });
});

describe('editor queries and media', () => {
  test('returns the active revision job only when it targets the current draft', async () => {
    const { t, author, machineId, versionId } = await setup();
    const args = { machineSlug: 'machine', procedureSlug: 'procedure' };
    expect(await author.query(api.procedures.getEditorContext, args)).toMatchObject({ activeJob: null });
    const other = await author.mutation(api.procedures.create, { machineId, slug: 'other', title: 'Other' });
    const otherJobId = await author.mutation(api.draftJobs.createRevision, {
      procedureVersionId: other.versionId, instruction: 'Clarify',
    });
    expect(await author.query(api.procedures.getEditorContext, args)).toMatchObject({ activeJob: null });
    await author.mutation(api.draftJobs.cancel, { jobId: otherJobId });
    const jobId = await author.mutation(api.draftJobs.createRevision, {
      procedureVersionId: versionId, instruction: 'Clarify',
    });
    expect(await author.query(api.procedures.getEditorContext, args)).toMatchObject({
      activeJob: { _id: jobId, status: 'queued', stage: 'queued' },
    });
    await t.mutation(api.draftJobs.claim, { workerId: 'worker', leaseSeconds: 60 });
    expect(await author.query(api.procedures.getEditorContext, args)).toMatchObject({
      activeJob: { _id: jobId, status: 'running', stage: 'claimed' },
    });
    await author.mutation(api.draftJobs.cancel, { jobId });
    expect(await author.query(api.procedures.getEditorContext, args)).toMatchObject({ activeJob: null });
  });

  test('resolves the source recording for editing and playback and copies it to later drafts', async () => {
    const { t, author, approver, trainee, procedureId, versionId } = await setup();
    const sourceVideoFileId = await t.run((ctx) => ctx.storage.store(new Blob(['source recording'])));
    await t.run((ctx) => ctx.db.patch(versionId, { sourceVideoFileId }));
    const sourceVideoUrl = await t.run((ctx) => ctx.storage.getUrl(sourceVideoFileId));
    expect(sourceVideoUrl).toEqual(expect.any(String));
    expect(await author.query(api.procedures.getVersion, { versionId })).toMatchObject({ sourceVideoUrl });

    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Recording reviewed' });
    expect(await trainee.query(api.procedures.getForPlay, {
      machineSlug: 'machine', procedureSlug: 'procedure',
    })).toMatchObject({ sourceVideoUrl });

    const draftId = await author.mutation(api.procedures.createDraft, { procedureId, fromVersionId: versionId });
    expect(await t.run((ctx) => ctx.db.get(draftId)))
      .toMatchObject({ sourceVideoFileId, copiedFromVersionId: versionId });
    expect(await author.query(api.procedures.getVersion, { versionId: draftId })).toMatchObject({ sourceVideoUrl });
  });

  test('rejects trainees and signed-out users from author queries', async () => {
    const { t, trainee, machineId } = await setup();
    for (const role of ['signed out', 'trainee']) {
      const client = role === 'signed out' ? t : trainee;
      const data = role === 'signed out' ? 'Not signed in' : 'Not authorized';
      await expect(client.query(api.procedures.getEditorContext, {
        machineSlug: 'machine', procedureSlug: 'procedure',
      })).rejects.toMatchObject({ data });
      await expect(client.query(api.procedures.listForMachine, { machineId }))
        .rejects.toMatchObject({ data });
    }
  });

  test('returns newest versions, both current ids, approved targets and draft self-links', async () => {
    const { author, approver, machineId, procedureId, versionId } = await setup();
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Initial' });
    const target = await author.mutation(api.procedures.create, { machineId, slug: 'target', title: 'Target' });
    await approver.mutation(api.procedures.approve, { versionId: target.versionId, changeNote: 'Target ready' });
    await author.mutation(api.procedures.create, { machineId, slug: 'unpublished', title: 'Unpublished' });
    const draftId = await author.mutation(api.procedures.createDraft, { procedureId });
    const content = emptyProcedureContent('Working title', definition);
    content.steps[0].id = 'draft-step';
    await author.mutation(api.procedures.saveDraft, { versionId: draftId, content });

    const context = await author.query(api.procedures.getEditorContext, {
      machineSlug: 'machine', procedureSlug: 'procedure',
    });
    expect(context).toMatchObject({
      machineId, procedureId, draftId, approvedId: versionId,
      machineSlug: 'machine', machineName: 'Machine', definition,
      modelUrl: expect.any(String),
      linkTargets: { procedure: ['step-1', 'draft-step'], target: ['step-1'] },
      procedureTitles: { procedure: 'Working title', target: 'Target' },
      mediaUrls: {},
    });
    expect(context?.linkTargets).not.toHaveProperty('unpublished');
    expect(context?.versions).toEqual([
      { _id: draftId, version: 2, status: 'draft', _creationTime: expect.any(Number) },
      {
        _id: versionId, version: 1, status: 'approved', _creationTime: expect.any(Number),
        approvedAt: expect.any(Number), changeNote: 'Initial',
      },
    ]);
    expect(await author.query(api.procedures.getVersion, { versionId: draftId }))
      .toMatchObject({ linkTargets: { procedure: ['draft-step'], target: ['step-1'] } });
    expect(await author.query(api.procedures.listForMachine, { machineId })).toEqual([
      { _id: procedureId, slug: 'procedure', title: 'Working title', hasDraft: true, hasApproved: true },
      { _id: target.procedureId, slug: 'target', title: 'Target', hasDraft: false, hasApproved: true },
      { _id: expect.any(String), slug: 'unpublished', title: 'Unpublished', hasDraft: true, hasApproved: false },
    ]);
  });

  test('lists procedures in creation order rather than title order', async () => {
    const { author, machineId } = await setup();
    await author.mutation(api.procedures.create, { machineId, slug: 'zulu', title: 'Zulu' });
    await author.mutation(api.procedures.create, { machineId, slug: 'alpha', title: 'Alpha' });

    const listed = await author.query(api.procedures.listForMachine, { machineId });
    expect(listed.map((procedure) => procedure.title)).toEqual(['Procedure', 'Zulu', 'Alpha']);
  });

  test('resolves draft and approved media while tolerating URL and missing-file references', async () => {
    const { t, author, approver, trainee, procedureId, versionId } = await setup();
    const approvedFile = await t.run((ctx) => ctx.storage.store(new Blob(['approved image'])));
    const draftFile = await t.run((ctx) => ctx.storage.store(new Blob(['draft image'])));
    const missingFile = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(['deleted image']));
      await ctx.storage.delete(id);
      return id;
    });
    const content = emptyProcedureContent('Screenshot', definition);
    content.steps[0].where = 'software';
    content.steps[0].media = { fileId: approvedFile, alt: 'Approved screen' };
    await author.mutation(api.procedures.saveDraft, { versionId, content });
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'With screenshot' });
    const approvedUrl = await t.run((ctx) => ctx.storage.getUrl(approvedFile));
    expect(await trainee.query(api.procedures.getForPlay, {
      machineSlug: 'machine', procedureSlug: 'procedure',
    })).toMatchObject({ mediaUrls: { [approvedFile]: approvedUrl } });

    const draftId = await author.mutation(api.procedures.createDraft, { procedureId });
    content.steps[0].media = { fileId: draftFile, alt: 'Draft screen' };
    content.steps.push(
      { ...content.steps[0], id: 'url', media: { fileId: '/image.png', alt: 'URL' } },
      { ...content.steps[0], id: 'missing', media: { fileId: missingFile, alt: 'Missing' } },
    );
    await author.mutation(api.procedures.saveDraft, { versionId: draftId, content });
    const draftUrl = await t.run((ctx) => ctx.storage.getUrl(draftFile));
    const context = await author.query(api.procedures.getEditorContext, {
      machineSlug: 'machine', procedureSlug: 'procedure',
    });
    expect(context?.mediaUrls).toEqual({ [approvedFile]: approvedUrl, [draftFile]: draftUrl });
    expect(await author.query(api.procedures.getVersion, { versionId: draftId }))
      .toMatchObject({ mediaUrls: { [draftFile]: draftUrl } });
  });

  test('handles missing routes and starts a draft for a procedure without versions', async () => {
    const { t, author, machineId } = await setup();
    for (const args of [
      { machineSlug: 'absent', procedureSlug: 'procedure' },
      { machineSlug: 'machine', procedureSlug: 'absent' },
    ]) {
      expect(await author.query(api.procedures.getEditorContext, args)).toBeNull();
    }
    const procedureId = await t.run((ctx) => ctx.db.insert('procedures', { machineId, slug: 'empty' }));
    expect(await author.query(api.procedures.getEditorContext, {
      machineSlug: 'machine', procedureSlug: 'empty',
    })).toMatchObject({ procedureId, versions: [] });
    const draftId = await author.mutation(api.procedures.createDraft, { procedureId });
    expect(await author.query(api.procedures.getVersion, { versionId: draftId })).toMatchObject({
      version: 1, status: 'draft', content: emptyProcedureContent('empty', definition),
    });
  });
});

describe('reference video URLs', () => {
  test('resolves approved and draft videos together with their step images', async () => {
    const { t, author, approver, trainee, procedureId, versionId } = await setup();
    const approvedVideo = await t.run((ctx) => ctx.storage.store(new Blob(['approved video'])));
    const draftVideo = await t.run((ctx) => ctx.storage.store(new Blob(['draft video'])));
    const image = await t.run((ctx) => ctx.storage.store(new Blob(['step image'])));
    const approvedUrl = await t.run((ctx) => ctx.storage.getUrl(approvedVideo));
    const draftUrl = await t.run((ctx) => ctx.storage.getUrl(draftVideo));
    const imageUrl = await t.run((ctx) => ctx.storage.getUrl(image));
    const content = emptyProcedureContent('Demonstration', definition);
    content.video = { fileId: approvedVideo, label: 'Original demonstration' };
    content.steps[0].media = { fileId: image, alt: 'Setup' };
    await author.mutation(api.procedures.saveDraft, { versionId, content });
    await approver.mutation(api.procedures.approve, { versionId, changeNote: 'Reference media' });

    const route = { machineSlug: 'machine', procedureSlug: 'procedure' };
    expect(await trainee.query(api.procedures.getForPlay, route)).toMatchObject({
      content,
      mediaUrls: { [approvedVideo]: approvedUrl, [image]: imageUrl },
    });
    const draftId = await author.mutation(api.procedures.createDraft, { procedureId });
    content.video = { fileId: draftVideo };
    await author.mutation(api.procedures.saveDraft, { versionId: draftId, content });
    expect(await author.query(api.procedures.getVersion, { versionId: draftId })).toMatchObject({
      content,
      mediaUrls: { [draftVideo]: draftUrl, [image]: imageUrl },
    });
    expect((await author.query(api.procedures.getEditorContext, route))?.mediaUrls).toEqual({
      [approvedVideo]: approvedUrl, [draftVideo]: draftUrl, [image]: imageUrl,
    });
    expect((await trainee.query(api.procedures.getForPlay, route))?.content.video?.fileId).toBe(approvedVideo);
  });

  test('omits unresolved video URLs without hiding available step images', async () => {
    const { t, author, versionId } = await setup();
    const deletedVideo = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(['deleted video']));
      await ctx.storage.delete(id);
      return id;
    });
    const image = await t.run((ctx) => ctx.storage.store(new Blob(['step image'])));
    const imageUrl = await t.run((ctx) => ctx.storage.getUrl(image));
    for (const fileId of [deletedVideo, 'reference.mp4']) {
      const content = emptyProcedureContent('Missing video', definition);
      content.video = { fileId };
      content.steps[0].media = { fileId: image, alt: 'Available image' };
      await author.mutation(api.procedures.saveDraft, { versionId, content });
      expect((await author.query(api.procedures.getVersion, { versionId }))?.mediaUrls)
        .toEqual({ [image]: imageUrl });
    }
  });
});

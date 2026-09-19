import { anyApi } from 'convex/server';
import type { ApiFromModules } from 'convex/server';
import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { describe, expect, test } from 'vitest';
import type { MachineDefinition } from '../shared/machine';
import { publishMachineVersion } from './lib/content';
import type * as machines from './machines';
import type * as procedures from './procedures';
import schema from './schema';
import { asUser, createUser, modules } from './test.setup';

// Keep these tests typed without requiring changes to checked-in generated files.
const api = anyApi as unknown as ApiFromModules<{
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
    name: 'front',
    label: 'Front',
    view: { pos: [1, 2, 3], target: [0, 0, 0] },
  }],
  stateVars: [{
    name: 'lift',
    label: 'Lift',
    kind: 'toggle',
    effects: [{ type: 'translate', node: 'head', offset: [0, 0.3, 0] }],
  }],
};

async function setup() {
  const t = convexTest(schema, modules);
  const adminId = await createUser(t, { email: 'admin@example.com', role: 'admin' });
  const authorId = await createUser(t, { email: 'author@example.com', role: 'author' });
  const traineeId = await createUser(t, { email: 'trainee@example.com', role: 'trainee' });
  const modelFileId = await t.run((ctx) => ctx.storage.store(new Blob(['x'])));
  return {
    t,
    admin: asUser(t, adminId),
    author: asUser(t, authorId),
    trainee: asUser(t, traineeId),
    publishArgs: { slug: 'machine', name: 'Machine', kind: 'instrument', modelFileId, definition },
  };
}

describe('machines.publishVersion', () => {
  test.each(['trainee', 'author', 'approver'] as const)('rejects %s', async (role) => {
    const { t, publishArgs } = await setup();
    const userId = await createUser(t, { email: `${role}@example.com`, role });
    await expect(asUser(t, userId).mutation(api.machines.publishVersion, publishArgs))
      .rejects.toMatchObject({ data: 'Not authorized' });
    expect(await t.run((ctx) => ctx.db.query('machines').collect())).toEqual([]);
  });

  test('requires a signed-in caller', async () => {
    const { t, publishArgs } = await setup();
    await expect(t.mutation(api.machines.publishVersion, publishArgs))
      .rejects.toMatchObject({ data: 'Not signed in' });
  });

  test('publishes immutable versions, increments the maximum and updates the current version', async () => {
    const { t, admin, author, publishArgs } = await setup();
    const first = await admin.mutation(api.machines.publishVersion, publishArgs);
    const firstDocument = await t.run((ctx) => ctx.db.get(first.machineVersionId));
    const nextDefinition = { ...definition, rootNode: 'new-instrument' };
    const modelFileId = await t.run((ctx) => ctx.storage.store(new Blob(['v2'])));
    const second = await admin.mutation(api.machines.publishVersion, {
      ...publishArgs,
      name: 'Renamed machine',
      kind: 'updated',
      definition: nextDefinition,
      modelFileId,
    });

    expect(first.version).toBe(1);
    expect(second).toMatchObject({ machineId: first.machineId, version: 2 });
    expect(await t.run((ctx) => ctx.db.get(first.machineId))).toMatchObject({
      name: 'Renamed machine',
      kind: 'updated',
      currentVersionId: second.machineVersionId,
    });
    expect(await t.run((ctx) => ctx.db.get(first.machineVersionId))).toEqual(firstDocument);
    expect(await t.run((ctx) => ctx.db.get(second.machineVersionId))).toMatchObject({
      status: 'published',
      definition: nextDefinition,
      modelFileId,
    });
    expect(await author.query(api.machines.listVersions, { machineId: first.machineId })).toEqual([
      { _id: second.machineVersionId, version: 2, status: 'published', _creationTime: expect.any(Number) },
      { _id: first.machineVersionId, version: 1, status: 'published', _creationTime: expect.any(Number) },
    ]);

    await t.run((ctx) => ctx.db.patch(first.machineId, { currentVersionId: first.machineVersionId }));
    const third = await admin.mutation(api.machines.publishVersion, publishArgs);
    expect(third.version).toBe(3);
    expect(await t.run((ctx) => ctx.db.query('machines').collect())).toHaveLength(1);
  });

  test('reports Zod refinement errors without inserting a machine', async () => {
    const { t, admin, publishArgs } = await setup();
    const publish = admin.mutation(api.machines.publishVersion, {
      ...publishArgs,
      definition: { ...definition, parts: [definition.parts[0], definition.parts[0]] },
    });
    await expect(publish).rejects.toBeInstanceOf(ConvexError);
    await expect(publish).rejects.toMatchObject({
      data: 'Invalid machine definition: parts.1.name: Duplicate name "head".',
    });
    expect(await t.run((ctx) => ctx.db.query('machines').collect())).toEqual([]);
  });

  test('rejects invalid vector lengths omitted by the bridged validator', async () => {
    const { admin, publishArgs } = await setup();
    const invalidDefinition = structuredClone(definition);
    invalidDefinition.presetViews[0].view.pos.pop();
    await expect(admin.mutation(api.machines.publishVersion, {
      ...publishArgs,
      definition: invalidDefinition,
    })).rejects.toMatchObject({
      data: expect.stringContaining('Invalid machine definition: presetViews.0.view.pos:'),
    });
  });
});

describe('publishMachineVersion', () => {
  test('defaults to published for existing callers and passes through the source file', async () => {
    const { t, publishArgs } = await setup();
    const sourceFileId = await t.run((ctx) => ctx.storage.store(new Blob(['source'])));
    const published = await t.run((ctx) => publishMachineVersion(ctx, { ...publishArgs, sourceFileId }));
    expect(await t.run((ctx) => ctx.db.get(published.machineVersionId))).toMatchObject({
      status: 'published', sourceFileId,
    });
    expect(await t.run((ctx) => ctx.db.get(published.machineId))).toMatchObject({
      currentVersionId: published.machineVersionId,
    });
  });

  test('preserves the machine when creating drafts and increments versions across both statuses', async () => {
    const { t, admin, author, publishArgs } = await setup();
    const first = await admin.mutation(api.machines.publishVersion, publishArgs);
    const before = await t.run((ctx) => ctx.db.get(first.machineId));
    const sourceFileId = await t.run((ctx) => ctx.storage.store(new Blob(['editable source'])));
    const draft = await t.run((ctx) => publishMachineVersion(ctx, {
      ...publishArgs, name: 'Draft name', kind: 'Draft kind', publish: false, sourceFileId,
    }));
    const nextDraft = await t.run((ctx) => publishMachineVersion(ctx, { ...publishArgs, publish: false }));
    expect(await t.run((ctx) => ctx.db.get(first.machineId))).toEqual(before);
    expect(await t.run((ctx) => ctx.db.get(draft.machineVersionId))).toMatchObject({
      machineId: first.machineId, version: 2, status: 'draft', sourceFileId,
    });
    expect(await t.run((ctx) => ctx.db.get(nextDraft.machineVersionId))).not.toHaveProperty('sourceFileId');
    expect(await author.query(api.machines.listVersions, { machineId: first.machineId })).toEqual([
      { _id: nextDraft.machineVersionId, version: 3, status: 'draft', _creationTime: expect.any(Number) },
      { _id: draft.machineVersionId, version: 2, status: 'draft', _creationTime: expect.any(Number) },
      { _id: first.machineVersionId, version: 1, status: 'published', _creationTime: expect.any(Number) },
    ]);
    const published = await admin.mutation(api.machines.publishVersion, publishArgs);
    expect(published).toMatchObject({ machineId: first.machineId, version: 4 });
    expect(await t.run((ctx) => ctx.db.get(first.machineId))).toMatchObject({
      currentVersionId: published.machineVersionId,
    });
  });
});

describe('machines.publishDraftVersion', () => {
  test.each(['trainee', 'author', 'approver'] as const)('rejects %s', async (role) => {
    const { t, publishArgs } = await setup();
    const userId = await createUser(t, { email: `${role}@example.com`, role });
    const { machineId, machineVersionId } = await t.run((ctx) =>
      publishMachineVersion(ctx, { ...publishArgs, publish: false }),
    );
    await expect(asUser(t, userId).mutation(api.machines.publishDraftVersion, { machineVersionId }))
      .rejects.toMatchObject({ data: 'Not authorized' });
    expect(await t.run((ctx) => ctx.db.get(machineVersionId))).toMatchObject({ status: 'draft' });
    expect(await t.run((ctx) => ctx.db.get(machineId))).not.toHaveProperty('currentVersionId');
  });

  test('requires a signed-in caller', async () => {
    const { t, publishArgs } = await setup();
    const { machineVersionId } = await t.run((ctx) =>
      publishMachineVersion(ctx, { ...publishArgs, publish: false }),
    );
    await expect(t.mutation(api.machines.publishDraftVersion, { machineVersionId }))
      .rejects.toMatchObject({ data: 'Not signed in' });
  });

  test.each([false, true])('publishes a draft with an existing current version: %s', async (hasCurrent) => {
    const { t, admin, publishArgs } = await setup();
    if (hasCurrent) {
      await admin.mutation(api.machines.publishVersion, publishArgs);
    }
    const { machineId, machineVersionId } = await t.run((ctx) =>
      publishMachineVersion(ctx, { ...publishArgs, publish: false }),
    );
    const machineBefore = await t.run((ctx) => ctx.db.get(machineId));
    const versionBefore = await t.run((ctx) => ctx.db.get(machineVersionId));
    expect(await admin.mutation(api.machines.publishDraftVersion, { machineVersionId })).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(machineId))).toEqual({
      ...machineBefore, currentVersionId: machineVersionId,
    });
    expect(await t.run((ctx) => ctx.db.get(machineVersionId))).toEqual({
      ...versionBefore, status: 'published',
    });
  });

  test.each(['same', 'newer'])('rejects a draft when the current version is %s', async (current) => {
    const { t, admin, publishArgs } = await setup();
    const { machineId, machineVersionId } = await t.run((ctx) =>
      publishMachineVersion(ctx, { ...publishArgs, publish: false }),
    );
    if (current === 'newer') {
      await admin.mutation(api.machines.publishVersion, publishArgs);
    } else {
      await t.run((ctx) => ctx.db.patch(machineId, { currentVersionId: machineVersionId }));
    }
    const before = await t.run((ctx) => ctx.db.get(machineId));
    await expect(admin.mutation(api.machines.publishDraftVersion, { machineVersionId }))
      .rejects.toMatchObject({ data: 'Machine version superseded' });
    expect(await t.run((ctx) => ctx.db.get(machineId))).toEqual(before);
    expect(await t.run((ctx) => ctx.db.get(machineVersionId))).toMatchObject({ status: 'draft' });
  });

  test.each(['published', undefined] as const)('rejects a published version with status %s', async (status) => {
    const { t, admin, publishArgs } = await setup();
    const { machineVersionId } = await admin.mutation(api.machines.publishVersion, publishArgs);
    await t.run((ctx) => ctx.db.patch(machineVersionId, { status }));
    await expect(admin.mutation(api.machines.publishDraftVersion, { machineVersionId }))
      .rejects.toMatchObject({ data: 'Only draft machine versions can be published' });
  });
});

describe('machines.list', () => {
  test('hides draft-only machines from trainees and legacy users while showing them to authors and admins', async () => {
    const { t, admin, author, trainee, publishArgs } = await setup();
    const draft = await t.run((ctx) => publishMachineVersion(ctx, { ...publishArgs, publish: false }));
    expect(await t.run((ctx) => ctx.db.get(draft.machineId))).toMatchObject({
      slug: 'machine', name: 'Machine', kind: 'instrument',
    });
    expect(await t.run((ctx) => ctx.db.get(draft.machineId))).not.toHaveProperty('currentVersionId');
    expect(await trainee.query(api.machines.list, {})).toEqual([]);
    const legacyId = await createUser(t, { email: 'legacy@example.com' });
    expect(await asUser(t, legacyId).query(api.machines.list, {})).toEqual([]);
    const authorList = await author.query(api.machines.list, {});
    expect(authorList).toEqual([{
      _id: draft.machineId, slug: 'machine', name: 'Machine', kind: 'instrument', procedures: [],
    }]);
    expect(await admin.query(api.machines.list, {})).toEqual(authorList);
    expect(await trainee.query(api.machines.getBySlug, { slug: 'machine' })).toBeNull();
  });

  test('returns procedures in creation order rather than title order', async () => {
    const { admin, author, publishArgs } = await setup();
    const { machineId } = await admin.mutation(api.machines.publishVersion, publishArgs);
    await author.mutation(api.procedures.create, { machineId, slug: 'zulu', title: 'Zulu' });
    await author.mutation(api.procedures.create, { machineId, slug: 'alpha', title: 'Alpha' });

    const listed = await author.query(api.machines.list, {});
    expect(listed.find((machine) => machine._id === machineId)?.procedures.map((procedure) => procedure.title))
      .toEqual(['Zulu', 'Alpha']);
  });

  test('hides unpublished procedures and draft flags from trainees, and uses approved summaries', async () => {
    const { t, admin, author, trainee, publishArgs } = await setup();
    const { machineId } = await admin.mutation(api.machines.publishVersion, publishArgs);
    const published = await author.mutation(api.procedures.create, {
      machineId, slug: 'published', title: 'Approved title',
    });
    await admin.mutation(api.procedures.approve, { versionId: published.versionId, changeNote: 'Initial' });
    const draftId = await author.mutation(api.procedures.createDraft, { procedureId: published.procedureId });
    const draft = await author.query(api.procedures.getVersion, { versionId: draftId });
    await author.mutation(api.procedures.saveDraft, {
      versionId: draftId, content: { ...draft.content, title: 'Draft title', minutes: 99 },
    });
    const unpublished = await author.mutation(api.procedures.create, {
      machineId, slug: 'unpublished', title: 'Unpublished title',
    });
    await admin.mutation(api.machines.publishVersion, { ...publishArgs, slug: 'alpha', name: 'Alpha' });

    const traineeList = await trainee.query(api.machines.list, {});
    expect(traineeList.map((machine) => machine.name)).toEqual(['Alpha', 'Machine']);
    expect(traineeList[1].procedures).toEqual([{
      _id: published.procedureId,
      slug: 'published',
      title: 'Approved title',
      minutes: 10,
      hasApproved: true,
      hasDraft: false,
    }]);
    const authorList = await author.query(api.machines.list, {});
    expect(authorList[1].procedures).toEqual([
      { ...traineeList[1].procedures[0], hasDraft: true },
      {
        _id: unpublished.procedureId,
        slug: 'unpublished',
        title: 'Unpublished title',
        minutes: 10,
        hasApproved: false,
        hasDraft: true,
      },
    ]);
    const legacyId = await createUser(t, { email: 'legacy@example.com' });
    expect(await asUser(t, legacyId).query(api.machines.list, {})).toEqual(traineeList);
  });

  test('uses the latest version when there is no approved version', async () => {
    const { t, admin, author, trainee, publishArgs } = await setup();
    const { machineId } = await admin.mutation(api.machines.publishVersion, publishArgs);
    const { procedureId, versionId } = await author.mutation(api.procedures.create, {
      machineId, slug: 'procedure', title: 'Latest title',
    });
    await t.run((ctx) => ctx.db.patch(versionId, { status: 'retired' }));
    const listed = await author.query(api.machines.list, {});
    expect(listed[0].procedures).toEqual([{
      _id: procedureId, slug: 'procedure', title: 'Latest title', minutes: 10,
      hasApproved: false, hasDraft: false,
    }]);
    expect((await trainee.query(api.machines.list, {}))[0].procedures).toEqual([]);
  });
});

describe('machine queries', () => {
  test('lists legacy versions without a status as published', async () => {
    const { t, admin, author, publishArgs } = await setup();
    const { machineId, machineVersionId } = await admin.mutation(api.machines.publishVersion, publishArgs);
    await t.run((ctx) => ctx.db.patch(machineVersionId, { status: undefined }));
    expect(await author.query(api.machines.listVersions, { machineId })).toEqual([{
      _id: machineVersionId, version: 1, status: 'published', _creationTime: expect.any(Number),
    }]);
  });

  test('getBySlug returns the current definition and storage URL', async () => {
    const { t, admin, trainee, publishArgs } = await setup();
    const first = await admin.mutation(api.machines.publishVersion, publishArgs);
    const currentDefinition = { ...definition, rootNode: 'current' };
    const second = await admin.mutation(api.machines.publishVersion, {
      ...publishArgs, definition: currentDefinition,
    });
    const modelUrl = await t.run((ctx) => ctx.storage.getUrl(publishArgs.modelFileId));
    expect(modelUrl).toEqual(expect.any(String));
    expect(await trainee.query(api.machines.getBySlug, { slug: 'machine' })).toEqual({
      _id: first.machineId, slug: 'machine', name: 'Machine', kind: 'instrument',
      version: { _id: second.machineVersionId, version: 2, definition: currentDefinition, modelUrl },
    });
  });

  test('returns null for a missing machine or a machine without a current version', async () => {
    const { t, trainee } = await setup();
    expect(await trainee.query(api.machines.getBySlug, { slug: 'missing' })).toBeNull();
    await t.run((ctx) => ctx.db.insert('machines', { slug: 'empty', name: 'Empty', kind: 'test' }));
    expect(await trainee.query(api.machines.getBySlug, { slug: 'empty' })).toBeNull();
  });

  test('requires sign-in and restricts version history to authors', async () => {
    const { t, admin, trainee, publishArgs } = await setup();
    const { machineId } = await admin.mutation(api.machines.publishVersion, publishArgs);
    await expect(t.query(api.machines.list, {})).rejects.toMatchObject({ data: 'Not signed in' });
    await expect(t.query(api.machines.getBySlug, { slug: 'machine' }))
      .rejects.toMatchObject({ data: 'Not signed in' });
    await expect(t.query(api.machines.listVersions, { machineId }))
      .rejects.toMatchObject({ data: 'Not signed in' });
    await expect(trainee.query(api.machines.listVersions, { machineId }))
      .rejects.toMatchObject({ data: 'Not authorized' });
  });
});

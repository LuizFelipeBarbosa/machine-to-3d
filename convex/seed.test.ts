import { anyApi } from 'convex/server';
import type { ApiFromModules } from 'convex/server';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import type { MachineDefinition } from '../shared/machine';
import { emptyProcedureContent } from './lib/content';
import type * as machines from './machines';
import type * as procedures from './procedures';
import type * as seed from './seed';
import type * as training from './training';
import schema from './schema';
import { asUser, createUser, modules } from './test.setup';

const api = anyApi as unknown as ApiFromModules<{
  machines: typeof machines;
  procedures: typeof procedures;
  seed: typeof seed;
  training: typeof training;
}>;

const definition: MachineDefinition = {
  formatVersion: 1, rootNode: 'instrument', parts: [], presetViews: [],
  stateVars: [{ name: 'lift', label: 'Lift', kind: 'toggle', effects: [{ type: 'visible', node: 'head' }] }],
};

async function setup() {
  const t = convexTest(schema, modules);
  const traineeId = await createUser(t, { email: 'trainee@example.com', role: 'trainee' });
  const modelFileId = await t.run((ctx) => ctx.storage.store(new Blob(['model'])));
  return {
    t,
    trainee: asUser(t, traineeId),
    machineArgs: { slug: 'machine', name: 'Machine', kind: 'instrument', modelFileId, definition },
    procedureArgs: {
      machineSlug: 'machine', slug: 'procedure',
      content: emptyProcedureContent('Procedure', definition),
      linkTargets: { procedure: ['step-1'] },
    },
  };
}

describe('seed machines', () => {
  test.each([
    { label: 'identical', repeatedDefinition: definition },
    {
      label: 'reordered object keys',
      repeatedDefinition: {
        stateVars: [{
          effects: [{ node: 'head', type: 'visible' }],
          kind: 'toggle', label: 'Lift', name: 'lift',
        }],
        presetViews: [], parts: [], rootNode: 'instrument', formatVersion: 1,
      } satisfies MachineDefinition,
    },
  ])('creates v1 then leaves $label definitions unchanged', async ({ repeatedDefinition }) => {
    const { t, machineArgs } = await setup();
    expect(await t.query(api.seed.machineStatus, { slug: 'machine' })).toEqual({ exists: false });
    expect(await t.mutation(api.seed.uploadUrl, {})).toEqual(expect.any(String));
    const first = await t.mutation(api.seed.upsertMachine, machineArgs);
    expect(first).toEqual({
      machineId: expect.any(String), machineVersionId: expect.any(String),
      version: 1, created: true, updated: false,
    });
    expect(await t.query(api.seed.machineStatus, { slug: 'machine' })).toEqual({
      exists: true, definition, version: 1,
    });
    const before = await t.run((ctx) => ctx.db.get(first.machineId));
    const versions = await t.run((ctx) => ctx.db.query('machineVersions').collect());
    expect(versions).toEqual([expect.objectContaining({
      _id: first.machineVersionId, machineId: first.machineId, version: 1,
      modelFileId: machineArgs.modelFileId, definition,
    })]);
    expect(await t.mutation(api.seed.upsertMachine, {
      ...machineArgs, name: 'Do not overwrite', definition: repeatedDefinition,
    })).toEqual({ ...first, created: false });
    expect(await t.run((ctx) => ctx.db.get(first.machineId))).toEqual(before);
    expect(await t.run((ctx) => ctx.db.query('machineVersions').collect())).toEqual(versions);
    expect(await t.run((ctx) => ctx.db.query('machines').collect())).toHaveLength(1);
  });

  test('publishes changed definitions as v2 while preserving procedures pinned to v1', async () => {
    const { t, machineArgs, procedureArgs } = await setup();
    const first = await t.mutation(api.seed.upsertMachine, machineArgs);
    const procedure = await t.mutation(api.seed.upsertProcedure, procedureArgs);
    if (!procedure.created) throw new Error('Expected a new procedure');
    const originalProcedure = await t.run((ctx) => ctx.db.get(procedure.versionId));
    const originalVersions = await t.run((ctx) => ctx.db.query('machineVersions').collect());
    const modelFileId = await t.run((ctx) => ctx.storage.store(new Blob(['updated model'])));
    const updatedDefinition: MachineDefinition = {
      ...definition, parts: [{ name: 'new-part', label: 'New', blurb: '' }],
    };

    const second = await t.mutation(api.seed.upsertMachine, {
      ...machineArgs, modelFileId, definition: updatedDefinition,
    });
    expect(second).toEqual({
      machineId: first.machineId, machineVersionId: expect.any(String),
      version: 2, created: false, updated: true,
    });
    expect(second.machineVersionId).not.toBe(first.machineVersionId);
    expect(await t.run((ctx) => ctx.db.query('machineVersions').collect())).toEqual([
      ...originalVersions,
      expect.objectContaining({
        _id: second.machineVersionId, machineId: first.machineId, version: 2,
        modelFileId, definition: updatedDefinition,
      }),
    ]);
    expect(await t.run((ctx) => ctx.db.get(first.machineId))).toMatchObject({
      currentVersionId: second.machineVersionId,
    });
    expect(await t.run((ctx) => ctx.db.query('machines').collect())).toHaveLength(1);
    expect(await t.query(api.seed.machineStatus, { slug: 'machine' })).toEqual({
      exists: true, definition: updatedDefinition, version: 2,
    });
    expect(await t.mutation(api.seed.upsertMachine, {
      ...machineArgs, modelFileId, definition: updatedDefinition,
    })).toEqual({ ...second, updated: false });
    expect(await t.mutation(api.seed.upsertProcedure, procedureArgs)).toEqual({
      created: false, updated: false, reason: 'unchanged',
    });
    expect(await t.run((ctx) => ctx.db.query('procedureVersions').collect())).toEqual([originalProcedure]);
    expect(originalProcedure).toMatchObject({ machineVersionId: first.machineVersionId });

    const content = structuredClone(procedureArgs.content);
    content.steps[0].parts = ['new-part'];
    const newProcedure = await t.mutation(api.seed.upsertProcedure, {
      ...procedureArgs, slug: 'new-procedure', content,
    });
    if (!newProcedure.created) throw new Error('Expected a new procedure');
    expect(await t.run((ctx) => ctx.db.get(newProcedure.versionId))).toMatchObject({
      machineVersionId: second.machineVersionId,
    });
  });

  test('treats array order changes as a new definition', async () => {
    const { t, machineArgs } = await setup();
    const parts = [
      { name: 'first', label: 'First', blurb: '' },
      { name: 'second', label: 'Second', blurb: '' },
    ];
    await t.mutation(api.seed.upsertMachine, {
      ...machineArgs, definition: { ...definition, parts },
    });
    expect(await t.mutation(api.seed.upsertMachine, {
      ...machineArgs, definition: { ...definition, parts: [...parts].reverse() },
    })).toMatchObject({ version: 2, created: false, updated: true });
  });

  test('reuses publication validation before creating anything', async () => {
    const { t, machineArgs } = await setup();
    await expect(t.mutation(api.seed.upsertMachine, {
      ...machineArgs, definition: { ...definition, stateVars: [definition.stateVars[0], definition.stateVars[0]] },
    })).rejects.toMatchObject({ data: expect.stringContaining('Invalid machine definition:') });
    expect(await t.query(api.seed.machineStatus, { slug: 'machine' })).toEqual({ exists: false });
    expect(await t.run((ctx) => ctx.db.query('machines').collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query('machineVersions').collect())).toEqual([]);
  });
});

describe('seed procedures', () => {
  test('creates approved v1 for playback without attribution, then leaves identical content unchanged', async () => {
    const { t, trainee, machineArgs, procedureArgs } = await setup();
    const machine = await t.mutation(api.seed.upsertMachine, machineArgs);
    const before = Date.now();
    const first = await t.mutation(api.seed.upsertProcedure, procedureArgs);
    expect(first.created).toBe(true);
    expect(first).toEqual({ created: true, updated: false, versionId: expect.any(String), version: 1 });
    if (!first.created) throw new Error('Expected a new procedure');
    const version = await t.run((ctx) => ctx.db.get(first.versionId));
    expect(version).toMatchObject({
      version: 1, status: 'approved', machineVersionId: machine.machineVersionId,
      content: procedureArgs.content, changeNote: 'Seeded',
    });
    expect(version!.approvedAt).toBeGreaterThanOrEqual(before);
    expect(version!.approvedAt).toBeLessThanOrEqual(Date.now());
    expect(version).not.toHaveProperty('createdBy');
    expect(version).not.toHaveProperty('approvedBy');
    expect(await trainee.query(api.procedures.getForPlay, {
      machineSlug: 'machine', procedureSlug: 'procedure',
    })).toMatchObject({ versionId: first.versionId, version: 1, content: procedureArgs.content });
    const storedProcedures = await t.run((ctx) => ctx.db.query('procedures').collect());
    expect(storedProcedures).toEqual([expect.objectContaining({ approvedVersionId: first.versionId })]);
    expect(await t.mutation(api.seed.upsertProcedure, procedureArgs)).toEqual({
      created: false, updated: false, reason: 'unchanged',
    });
    expect(await t.run((ctx) => ctx.db.query('procedureVersions').collect())).toEqual([version]);
    expect(await t.run((ctx) => ctx.db.query('procedures').collect())).toEqual(storedProcedures);
  });

  test('leaves content with reordered object keys unchanged', async () => {
    const { t, machineArgs, procedureArgs } = await setup();
    await t.mutation(api.seed.upsertMachine, machineArgs);
    await t.mutation(api.seed.upsertProcedure, procedureArgs);
    const versions = await t.run((ctx) => ctx.db.query('procedureVersions').collect());
    const content = structuredClone(procedureArgs.content);
    const { pos, target } = content.steps[0].view;
    content.steps[0].view = { target, pos };
    expect(await t.mutation(api.seed.upsertProcedure, { ...procedureArgs, content })).toEqual({
      created: false, updated: false, reason: 'unchanged',
    });
    expect(await t.run((ctx) => ctx.db.query('procedureVersions').collect())).toEqual(versions);
  });

  test('republishes changed content as v2 against the current machine version', async () => {
    const { t, trainee, machineArgs, procedureArgs } = await setup();
    await t.mutation(api.seed.upsertMachine, machineArgs);
    const first = await t.mutation(api.seed.upsertProcedure, procedureArgs);
    if (!first.created) throw new Error('Expected a new procedure');
    const original = await t.run((ctx) => ctx.db.get(first.versionId));
    const current = await t.mutation(api.seed.upsertMachine, {
      ...machineArgs, definition: { ...definition, parts: [{ name: 'new-part', label: 'New', blurb: '' }] },
    });
    const content = structuredClone(procedureArgs.content);
    content.steps[0].body = 'Corrected instructions';
    content.steps[0].parts = ['new-part'];
    const before = Date.now();
    const second = await t.mutation(api.seed.upsertProcedure, { ...procedureArgs, content });
    expect(second).toEqual({ created: false, updated: true, versionId: expect.any(String), version: 2 });
    if (!second.updated) throw new Error('Expected an updated procedure');
    const version = await t.run((ctx) => ctx.db.get(second.versionId));
    expect(version).toMatchObject({
      version: 2, status: 'approved', content, changeNote: 'Seeded',
      machineVersionId: current.machineVersionId,
    });
    expect(version!.approvedAt).toBeGreaterThanOrEqual(before);
    expect(version!.approvedAt).toBeLessThanOrEqual(Date.now());
    expect(version).not.toHaveProperty('createdBy');
    expect(version).not.toHaveProperty('approvedBy');
    expect(await t.run((ctx) => ctx.db.get(first.versionId))).toEqual({ ...original, status: 'retired' });
    expect(await trainee.query(api.procedures.getForPlay, {
      machineSlug: 'machine', procedureSlug: 'procedure',
    })).toMatchObject({ versionId: second.versionId, version: 2, content });
    expect(await t.run((ctx) => ctx.db.query('procedures').collect())).toEqual([
      expect.objectContaining({ approvedVersionId: second.versionId }),
    ]);
    expect(await t.run((ctx) => ctx.db.query('procedureVersions').collect())).toHaveLength(2);
  });

  test('keeps training records pinned to the original content after republishing', async () => {
    const { t, trainee, machineArgs, procedureArgs } = await setup();
    await t.mutation(api.seed.upsertMachine, machineArgs);
    const first = await t.mutation(api.seed.upsertProcedure, procedureArgs);
    if (!first.created) throw new Error('Expected a new procedure');
    const recordId = await trainee.mutation(api.training.complete, {
      procedureVersionId: first.versionId, checkpoints: [],
    });
    const record = await t.run((ctx) => ctx.db.get(recordId));
    const content = structuredClone(procedureArgs.content);
    content.steps[0].body = 'Corrected instructions';
    expect(await t.mutation(api.seed.upsertProcedure, { ...procedureArgs, content }))
      .toMatchObject({ created: false, updated: true, version: 2 });
    expect(await t.run((ctx) => ctx.db.get(recordId))).toEqual(record);
    expect(record).toMatchObject({ procedureVersionId: first.versionId });
    expect(await t.run((ctx) => ctx.db.get(first.versionId))).toMatchObject({
      status: 'retired', content: procedureArgs.content,
    });
  });

  test('leaves a human-approved version and its history untouched', async () => {
    const { t, machineArgs, procedureArgs } = await setup();
    await t.mutation(api.seed.upsertMachine, machineArgs);
    const first = await t.mutation(api.seed.upsertProcedure, procedureArgs);
    if (!first.created) throw new Error('Expected a new procedure');
    const original = await t.run((ctx) => ctx.db.get(first.versionId));
    const approverId = await createUser(t, { email: 'approver@example.com', role: 'approver' });
    const approver = asUser(t, approverId);
    const humanVersionId = await approver.mutation(api.procedures.createDraft, {
      procedureId: original!.procedureId,
    });
    await approver.mutation(api.procedures.approve, {
      versionId: humanVersionId, changeNote: 'Reviewed by a human',
    });
    const versions = await t.run((ctx) => ctx.db.query('procedureVersions').collect());
    expect(versions).toContainEqual(expect.objectContaining({
      _id: humanVersionId, version: 2, status: 'approved', createdBy: approverId,
    }));
    const content = structuredClone(procedureArgs.content);
    content.steps[0].body = 'Corrected seed instructions';
    expect(await t.mutation(api.seed.upsertProcedure, { ...procedureArgs, content })).toEqual({
      created: false, updated: false, reason: 'human-authored',
    });
    expect(await t.run((ctx) => ctx.db.query('procedureVersions').collect())).toEqual(versions);
    expect(await t.run((ctx) => ctx.db.get(original!.procedureId))).toMatchObject({
      approvedVersionId: humanVersionId,
    });
  });

  test.each(['human change note', 'human attribution', 'no approved version'] as const)(
    'protects procedures with %s even when other versions are seed-managed',
    async (scenario) => {
      const { t, machineArgs, procedureArgs } = await setup();
      await t.mutation(api.seed.upsertMachine, machineArgs);
      const first = await t.mutation(api.seed.upsertProcedure, procedureArgs);
      if (!first.created) throw new Error('Expected a new procedure');
      const content = structuredClone(procedureArgs.content);
      content.steps[0].body = 'Corrected instructions';
      const second = await t.mutation(api.seed.upsertProcedure, { ...procedureArgs, content });
      if (!second.updated) throw new Error('Expected an updated procedure');
      const authorId = await createUser(t, { email: 'author@example.com', role: 'author' });
      await t.run(async (ctx) => {
        if (scenario === 'human change note') {
          await ctx.db.patch(first.versionId, { changeNote: 'Human revision' });
        } else if (scenario === 'human attribution') {
          await ctx.db.patch(first.versionId, { createdBy: authorId });
        } else {
          const version = await ctx.db.get(second.versionId);
          await ctx.db.patch(second.versionId, { status: 'retired' });
          await ctx.db.patch(version!.procedureId, { approvedVersionId: undefined });
        }
      });
      const versions = await t.run((ctx) => ctx.db.query('procedureVersions').collect());
      const procedures = await t.run((ctx) => ctx.db.query('procedures').collect());
      expect(await t.mutation(api.seed.upsertProcedure, procedureArgs)).toEqual({
        created: false, updated: false, reason: 'human-authored',
      });
      expect(await t.run((ctx) => ctx.db.query('procedureVersions').collect())).toEqual(versions);
      expect(await t.run((ctx) => ctx.db.query('procedures').collect())).toEqual(procedures);
    },
  );

  test('rejects invalid changed content without retiring the approved version', async () => {
    const { t, machineArgs, procedureArgs } = await setup();
    await t.mutation(api.seed.upsertMachine, machineArgs);
    await t.mutation(api.seed.upsertProcedure, procedureArgs);
    const versions = await t.run((ctx) => ctx.db.query('procedureVersions').collect());
    const procedures = await t.run((ctx) => ctx.db.query('procedures').collect());
    const content = structuredClone(procedureArgs.content);
    content.steps[0].parts = ['unknown'];
    await expect(t.mutation(api.seed.upsertProcedure, { ...procedureArgs, content }))
      .rejects.toMatchObject({
        data: 'Invalid procedure references:\nsteps[0].parts[0]: Unknown part "unknown".',
      });
    expect(await t.run((ctx) => ctx.db.query('procedureVersions').collect())).toEqual(versions);
    expect(await t.run((ctx) => ctx.db.query('procedures').collect())).toEqual(procedures);
  });

  test('reports every invalid reference and inserts nothing', async () => {
    const { t, machineArgs, procedureArgs } = await setup();
    await t.mutation(api.seed.upsertMachine, machineArgs);
    const content = structuredClone(procedureArgs.content);
    content.start = {};
    content.steps[0].parts = ['unknown'];
    content.steps[0].link = { procedureSlug: 'missing', label: 'Go' };
    await expect(t.mutation(api.seed.upsertProcedure, { ...procedureArgs, content }))
      .rejects.toMatchObject({
        data: 'Invalid procedure references:\nstart.lift: Missing initial state for "lift".\nsteps[0].parts[0]: Unknown part "unknown".\nsteps[0].link.procedureSlug: Unknown linked procedure "missing".',
      });
    expect(await t.run((ctx) => ctx.db.query('procedures').collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query('procedureVersions').collect())).toEqual([]);
  });

  test('validates against supplied forward link targets and the current machine version', async () => {
    const { t, machineArgs, procedureArgs } = await setup();
    await t.mutation(api.seed.upsertMachine, machineArgs);
    const adminId = await createUser(t, { email: 'admin@example.com', role: 'admin' });
    const current = await asUser(t, adminId).mutation(api.machines.publishVersion, {
      ...machineArgs, definition: { ...definition, parts: [{ name: 'new-part', label: 'New', blurb: '' }] },
    });
    const content = structuredClone(procedureArgs.content);
    content.steps[0].parts = ['new-part'];
    content.steps[0].link = { procedureSlug: 'later', stepId: 'target', label: 'Go' };
    await expect(t.mutation(api.seed.upsertProcedure, {
      ...procedureArgs, content, linkTargets: { later: ['wrong-step'] },
    })).rejects.toMatchObject({ data: expect.stringContaining('Unknown step "target"') });
    const result = await t.mutation(api.seed.upsertProcedure, {
      ...procedureArgs, content, linkTargets: { later: ['target'] },
    });
    if (!result.created) throw new Error('Expected a new procedure');
    expect(await t.run((ctx) => ctx.db.get(result.versionId)))
      .toMatchObject({ machineVersionId: current.machineVersionId });
  });
});

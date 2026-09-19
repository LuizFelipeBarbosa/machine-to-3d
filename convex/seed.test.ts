import { anyApi } from 'convex/server';
import type { ApiFromModules } from 'convex/server';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import type { MachineDefinition } from '../shared/machine';
import { emptyProcedureContent } from './lib/content';
import type * as machines from './machines';
import type * as procedures from './procedures';
import type * as seed from './seed';
import schema from './schema';
import { asUser, createUser, modules } from './test.setup';

const api = anyApi as unknown as ApiFromModules<{
  machines: typeof machines;
  procedures: typeof procedures;
  seed: typeof seed;
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
  test('creates v1 then skips without changing the machine or its versions', async () => {
    const { t, machineArgs } = await setup();
    expect(await t.query(api.seed.machineExists, { slug: 'machine' })).toBe(false);
    expect(await t.mutation(api.seed.uploadUrl, {})).toEqual(expect.any(String));
    const first = await t.mutation(api.seed.upsertMachine, machineArgs);
    expect(first.created).toBe(true);
    expect(await t.query(api.seed.machineExists, { slug: 'machine' })).toBe(true);
    const before = await t.run((ctx) => ctx.db.get(first.machineId));
    const versions = await t.run((ctx) => ctx.db.query('machineVersions').collect());
    expect(versions).toEqual([expect.objectContaining({
      _id: first.machineVersionId, machineId: first.machineId, version: 1,
      modelFileId: machineArgs.modelFileId, definition,
    })]);
    expect(await t.mutation(api.seed.upsertMachine, {
      ...machineArgs, name: 'Do not overwrite', definition: { ...definition, rootNode: 'other' },
    })).toEqual({ ...first, created: false });
    expect(await t.run((ctx) => ctx.db.get(first.machineId))).toEqual(before);
    expect(await t.run((ctx) => ctx.db.query('machineVersions').collect())).toEqual(versions);
    expect(await t.run((ctx) => ctx.db.query('machines').collect())).toHaveLength(1);
  });

  test('reuses publication validation before creating anything', async () => {
    const { t, machineArgs } = await setup();
    await expect(t.mutation(api.seed.upsertMachine, {
      ...machineArgs, definition: { ...definition, stateVars: [definition.stateVars[0], definition.stateVars[0]] },
    })).rejects.toMatchObject({ data: expect.stringContaining('Invalid machine definition:') });
    expect(await t.query(api.seed.machineExists, { slug: 'machine' })).toBe(false);
  });
});

describe('seed procedures', () => {
  test('creates approved v1 for playback without attribution, then skips without changes', async () => {
    const { t, trainee, machineArgs, procedureArgs } = await setup();
    const machine = await t.mutation(api.seed.upsertMachine, machineArgs);
    const before = Date.now();
    const first = await t.mutation(api.seed.upsertProcedure, procedureArgs);
    expect(first.created).toBe(true);
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
    expect(await t.mutation(api.seed.upsertProcedure, {
      ...procedureArgs, content: { ...procedureArgs.content, title: 'Do not overwrite' },
    })).toEqual({ created: false });
    expect(await t.run((ctx) => ctx.db.query('procedureVersions').collect())).toEqual([version]);
    expect(await t.run((ctx) => ctx.db.query('procedures').collect())).toEqual(storedProcedures);
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

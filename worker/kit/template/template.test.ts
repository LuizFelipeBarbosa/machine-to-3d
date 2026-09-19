import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exportModel } from '../../../scripts/export-model.js';
import { summarizeGlb } from '../../../scripts/lib/glb.js';
import { MachineDefinitionSchema, referencedClips, referencedNodes } from '../../../shared/machine.js';

describe('model kit template', () => {
  it('contains the named parts and door animation in the committed GLB', async () => {
    const bytes = await readFile(new URL('./model.glb', import.meta.url));
    const summary = summarizeGlb(bytes);
    expect(summary.rootNodes).toEqual(['Kit_Box']);
    expect(summary.namedNodes).toEqual(expect.arrayContaining(['body', 'door', 'panel']));
    expect(summary.animations).toEqual([
      { name: 'doorOpen', duration: 1.5, targetNodes: ['door'] },
    ]);
    expect(summary.meshCount).toBeGreaterThan(0);
  });

  it('validates the machine definition and resolves every node and clip reference', async () => {
    const json = await readFile(new URL('./machine.json', import.meta.url), 'utf8');
    const result = MachineDefinitionSchema.safeParse(JSON.parse(json));
    expect(result.success).toBe(true);
    if (!result.success) throw result.error;

    const bytes = await readFile(new URL('./model.glb', import.meta.url));
    const summary = summarizeGlb(bytes);
    for (const name of referencedNodes(result.data)) {
      expect(summary.namedNodes).toContain(name);
    }
    const clipNames = summary.animations.map(animation => animation.name);
    for (const name of referencedClips(result.data)) {
      expect(clipNames).toContain(name);
    }
  });

  it('reproduces the committed node and animation summaries under Node', async () => {
    const committed = summarizeGlb(await readFile(new URL('./model.glb', import.meta.url)));
    const modulePath = fileURLToPath(new URL('./buildModel.ts', import.meta.url));
    const exported = summarizeGlb(await exportModel(modulePath));
    expect(exported.rootNodes).toEqual(committed.rootNodes);
    expect(exported.namedNodes).toEqual(committed.namedNodes);
    expect(exported.animations).toEqual(committed.animations);
  });
});

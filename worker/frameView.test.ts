import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nodeBounds, parseGlbJson, summarizeGlb } from '../scripts/lib/glb.js';
import { MachineDefinitionSchema } from '../shared/machine.js';
import type { ProcedureContent } from '../shared/procedure.js';
import { frameView, stepViews } from './frameView.js';
import type { Bounds } from './frameView.js';

const glb = readFileSync(new URL('./kit/template/model.glb', import.meta.url));
const definition = MachineDefinitionSchema.parse(JSON.parse(
  readFileSync(new URL('./kit/template/machine.json', import.meta.url), 'utf8'),
));
const modelBounds = summarizeGlb(glb).boundingBox!;

function procedure(parts: string[]): ProcedureContent {
  return {
    formatVersion: 1,
    title: 'Inspect the machine',
    summary: 'Check the door and housing.',
    minutes: 5,
    start: { doorOpen: false },
    steps: [{
      id: 'inspect-door',
      title: 'Inspect the door',
      where: 'instrument',
      body: 'Open the door and inspect the seal.',
      parts,
      view: { pos: [99, 99, 99], target: [99, 99, 99] },
      state: { doorOpen: true },
      caution: 'Keep fingers clear of the hinge.',
      check: 'Seal is clean',
      media: { fileId: 'seal-photo', alt: 'Door seal' },
      link: { procedureSlug: 'cleaning', stepId: 'clean-seal', label: 'Clean the seal' },
    }],
  };
}

function diagonal(bounds: Bounds): number {
  return Math.hypot(...bounds.max.map((value, axis) => value - bounds.min[axis]));
}

function makeGlb(document: unknown): Uint8Array {
  const json = Buffer.from(JSON.stringify(document));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(20 + paddedLength, 0x20);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(paddedLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  json.copy(bytes, 20);
  return bytes;
}

describe('frameView', () => {
  it('uses the app FOV, padding, and normalized front-left direction', () => {
    const bounds: Bounds = { min: [-1, -2, -2], max: [1, 2, 2] };
    const view = frameView(bounds, bounds);
    // Radius 3 at FOV 36 degrees and padding 1.35 gives distance 13.106...
    expect(view).toEqual({ pos: [-5.88, 4.81, 10.68], target: [0, 0, 0] });
  });

  it('honors custom FOV, padding, direction, and centre rounding', () => {
    const bounds: Bounds = { min: [0.123, 0.234, 0.346], max: [2.123, 4.234, 4.346] };
    expect(frameView(bounds, bounds, { fovDegrees: 60, padding: 2, direction: [0, 0, 7] }))
      .toEqual({ pos: [1.12, 2.23, 14.35], target: [1.12, 2.23, 2.35] });
  });

  it('keeps a tiny or point target at least 35% of the model diagonal away', () => {
    const model: Bounds = { min: [-3, -4, 0], max: [3, 4, 0] };
    for (const halfSize of [0, 0.01]) {
      const target: Bounds = { min: [-halfSize, -halfSize, -halfSize], max: [halfSize, halfSize, halfSize] };
      expect(frameView(target, model, { direction: [0, 2, 0] }))
        .toEqual({ pos: [0, 3.5, 0], target: [0, 0, 0] });
    }
  });
});

describe('stepViews', () => {
  it('frames the door rest-pose bounds with padding above and in front-left', () => {
    const door = nodeBounds(glb, ['door'])!;
    const view = stepViews(glb, procedure(['door']), definition).steps[0].view;
    for (let axis = 0; axis < 3; axis++) {
      expect(view.target[axis]).toBeGreaterThanOrEqual(door.min[axis]);
      expect(view.target[axis]).toBeLessThanOrEqual(door.max[axis]);
    }
    const distance = Math.hypot(...view.pos.map((value, axis) => value - view.target[axis]));
    const paddedDistance = diagonal(door) / 2 / Math.sin(Math.PI / 10) * 1.35;
    // Rounding each coordinate can change the resulting distance by up to 0.02.
    expect(Math.abs(distance - Math.max(paddedDistance, 0.35 * diagonal(modelBounds))))
      .toBeLessThan(0.02);
    expect(distance).toBeGreaterThan(diagonal(modelBounds) / 2 * 1.35);
    expect(view.pos[0]).toBeLessThan(view.target[0]);
    expect(view.pos[1]).toBeGreaterThan(view.target[1]);
    expect(view.pos[2]).toBeGreaterThan(view.target[2]);
  });

  it('centres an overview on the model for steps with no parts or unknown parts', () => {
    const overview = stepViews(glb, procedure([]), definition).steps[0].view;
    expect(overview.target).toEqual(modelBounds.min.map((value, axis) =>
      Number(((value + modelBounds.max[axis]) / 2).toFixed(2)),
    ));
    expect(overview).toEqual(frameView(modelBounds, modelBounds));
    expect(stepViews(glb, procedure(['missing-part']), definition).steps[0].view).toEqual(overview);
  });

  it('falls back to the overview for a named subtree without geometry', () => {
    const document = parseGlbJson(glb) as { nodes: { name?: string }[] };
    document.nodes.push({ name: 'empty-part' });
    const bytes = makeGlb(document);
    expect(nodeBounds(bytes, ['empty-part'])).toBeNull();
    expect(stepViews(bytes, procedure(['empty-part']), definition).steps[0].view)
      .toEqual(frameView(modelBounds, modelBounds));
  });

  it('frames the union of known parts when a step also names an unknown part', () => {
    const parts = ['door', 'panel'];
    const bounds = nodeBounds(glb, parts)!;
    expect(stepViews(glb, procedure([...parts, 'missing-part']), definition).steps[0].view)
      .toEqual(frameView(bounds, modelBounds));
  });

  it('replaces every view while preserving other fields and the inputs', () => {
    const content = procedure(['door']);
    content.steps.push({ ...procedure([]).steps[0], id: 'overview', state: { doorOpen: false } });
    const originalContent = structuredClone(content);
    const originalDefinition = structuredClone(definition);
    const originalGlb = Buffer.from(glb);
    const result = stepViews(glb, content, definition);
    expect(result).not.toBe(content);
    expect(result.steps).not.toBe(content.steps);
    result.steps.forEach((step, index) => {
      expect(step).not.toBe(content.steps[index]);
      expect(step.view).not.toEqual(content.steps[index].view);
    });
    expect({ ...result, steps: result.steps.map((step, index) => ({
      ...step, view: content.steps[index].view,
    })) }).toEqual(content);
    expect(content).toEqual(originalContent);
    expect(definition).toEqual(originalDefinition);
    expect(glb).toEqual(originalGlb);
  });

  it('rejects a model without bounds instead of inventing an overview', () => {
    expect(() => stepViews(makeGlb({}), procedure([]), definition))
      .toThrow('Cannot frame a GLB without model bounds.');
  });
});

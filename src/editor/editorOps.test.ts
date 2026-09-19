import { afterEach, describe, expect, it, vi } from 'vitest';
import type { View } from '../../shared/machine';
import type { ProcedureContent, Step } from '../../shared/procedure';
import * as ops from './editorOps';

const view: View = { pos: [1, 2, 3], target: [0, 0, 0] };

function makeContent(): ProcedureContent {
  return {
    formatVersion: 1,
    title: 'Prepare the machine',
    summary: 'Raise and lower the head.',
    minutes: 5,
    start: { lift: false, covers: true },
    steps: [
      {
        id: 'raise', title: 'Raise', where: 'instrument', body: '', parts: ['head'],
        view: structuredClone(view), state: { lift: true },
      },
      {
        id: 'uncover', title: 'Uncover', where: 'instrument', body: '', parts: ['z'],
        view: structuredClone(view), state: { covers: false },
      },
      {
        id: 'lower', title: 'Lower', where: 'instrument', body: '', parts: [],
        view: structuredClone(view), state: { lift: false },
      },
    ],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('editorOps', () => {
  it('creates a blank step with independent view vectors and parts', () => {
    const step = ops.blankStep('new', view);
    expect(step).toStrictEqual({
      id: 'new', title: 'New step', where: 'instrument', body: '', parts: [], view,
    });
    expect(step.view).not.toBe(view);
    expect(step.view.pos).not.toBe(view.pos);
    expect(step.view.target).not.toBe(view.target);
    expect(step.parts).not.toBe(ops.blankStep('other', view).parts);
  });

  it('retries colliding random ids and preserves leading zeroes', () => {
    const random = vi.spyOn(crypto, 'getRandomValues');
    random.mockImplementationOnce((array) => {
      (array as Uint8Array).set([0, 1, 2, 3]);
      return array;
    });
    random.mockImplementationOnce((array) => {
      (array as Uint8Array).set([0, 1, 2, 4]);
      return array;
    });
    expect(ops.newStepId([ops.blankStep('step-00010203', view)])).toBe('step-00010204');
    expect(random).toHaveBeenCalledTimes(2);
  });

  it.each(['raise', null, 'missing'])('adds after %s, appending for null or stale ids', (afterId) => {
    const content = makeContent();
    const result = ops.addStepAfter(content, afterId, view);
    expect(result.stepId).toMatch(/^step-[0-9a-f]{8}$/);
    expect(content.steps.some((step) => step.id === result.stepId)).toBe(false);
    const expectedIds = afterId === 'raise'
      ? ['raise', result.stepId, 'uncover', 'lower']
      : ['raise', 'uncover', 'lower', result.stepId];
    expect(result.content.steps.map((step) => step.id)).toEqual(expectedIds);
    const added = result.content.steps.find((step) => step.id === result.stepId)!;
    expect(added.view).toStrictEqual(view);
    expect(added.view.pos).not.toBe(view.pos);
    expect(added.view.target).not.toBe(view.target);
  });

  it('removes a middle step and refuses to remove the only step', () => {
    const result = ops.removeStep(makeContent(), 'uncover');
    expect(result.steps.map((step) => step.id)).toEqual(['raise', 'lower']);
    const single = ops.removeStep(result, 'lower');
    expect(ops.removeStep(single, 'raise')).toBe(single);
  });

  it('moves in both directions and respects bounds', () => {
    const content = makeContent();
    expect(ops.moveStep(content, 'uncover', -1).steps.map((step) => step.id))
      .toEqual(['uncover', 'raise', 'lower']);
    expect(ops.moveStep(content, 'uncover', 1).steps.map((step) => step.id))
      .toEqual(['raise', 'lower', 'uncover']);
    expect(ops.moveStep(content, 'raise', -1)).toBe(content);
    expect(ops.moveStep(content, 'lower', 1)).toBe(content);
  });

  it('patches fields and deletes optional fields explicitly set to undefined', () => {
    const patch: Partial<Omit<Step, 'id'>> = {
      title: 'Updated', body: 'Instructions', caution: 'Careful', check: 'Confirmed',
      media: { fileId: 'photo', alt: 'Head' },
      link: { procedureSlug: 'other', label: 'Next procedure' }, state: { lift: false },
    };
    const updated = ops.patchStep(makeContent(), 'raise', patch);
    expect(updated.steps[0]).toMatchObject({ id: 'raise', ...patch });
    const removed = ops.patchStep(updated, 'raise', {
      caution: undefined, check: undefined, media: undefined, link: undefined, state: undefined,
    });
    for (const key of ['caution', 'check', 'media', 'link', 'state']) {
      expect(Object.hasOwn(removed.steps[0], key)).toBe(false);
    }
    expect(removed.steps[0].title).toBe('Updated');
  });

  it('adds and removes parts without losing other parts', () => {
    const added = ops.togglePart(makeContent(), 'raise', 'z');
    expect(added.steps[0].parts).toEqual(['head', 'z']);
    expect(ops.togglePart(added, 'raise', 'z').steps[0].parts).toEqual(['head']);
  });

  it('deletes provenance when explicitly cleared', () => {
    const content = ops.patchStep(makeContent(), 'raise', { provenance: 'inferred' });
    const cleared = ops.patchStep(content, 'raise', { provenance: undefined });
    expect(Object.hasOwn(cleared.steps[0], 'provenance')).toBe(false);
    expect(content.steps[0].provenance).toBe('inferred');
  });

  it('preserves a source timestamp of zero', () => {
    const content = ops.patchStep(makeContent(), 'raise', { sourceTimestamp: 0 });
    expect(Object.hasOwn(content.steps[0], 'sourceTimestamp')).toBe(true);
    expect(content.steps[0].sourceTimestamp).toBe(0);
  });

  it('sets absolute true and false values, inherits with null, and drops empty state', () => {
    const content = makeContent();
    const repeated = ops.setStepState(content, 'raise', 'lift', true);
    expect(repeated.steps[0].state).toStrictEqual({ lift: true });
    const off = ops.setStepState(repeated, 'raise', 'lift', false);
    expect(off.steps[0].state).toStrictEqual({ lift: false });
    const both = ops.setStepState(off, 'raise', 'covers', false);
    const inherit = ops.setStepState(both, 'raise', 'lift', null);
    expect(inherit.steps[0].state).toStrictEqual({ covers: false });
    const empty = ops.setStepState(inherit, 'raise', 'covers', null);
    expect(Object.hasOwn(empty.steps[0], 'state')).toBe(false);
    expect(ops.setStepState(empty, 'raise', 'lift', true).steps[0].state)
      .toStrictEqual({ lift: true });
    expect(ops.setStepState(empty, 'raise', 'absent', null)).toStrictEqual(empty);
    const inherited = ops.setStepState(content, 'lower', 'lift', null);
    expect(ops.stateForStep(inherited, 'lower').lift).toBe(true);
  });

  it('sets numeric step values and inherits without removing other numeric or boolean values', () => {
    const content = makeContent();
    content.start.demo = 0.18;
    const updated = ops.setStepState(content, 'raise', 'demo', 0.6);
    expect(updated.steps[0].state).toStrictEqual({ lift: true, demo: 0.6 });
    expect(ops.stateForStep(updated, 'uncover').demo).toBe(0.6);

    const inheritFraction = ops.setStepState(updated, 'raise', 'demo', null);
    expect(inheritFraction.steps[0].state).toStrictEqual({ lift: true });
    expect(ops.stateForStep(inheritFraction, 'raise').demo).toBe(0.18);

    const inheritToggle = ops.setStepState(updated, 'raise', 'lift', null);
    expect(inheritToggle.steps[0].state).toStrictEqual({ demo: 0.6 });
    const zero = ops.setStepState(inheritToggle, 'raise', 'demo', 0);
    expect(zero.steps[0].state).toStrictEqual({ demo: 0 });
    const empty = ops.setStepState(zero, 'raise', 'demo', null);
    expect(Object.hasOwn(empty.steps[0], 'state')).toBe(false);
    expect(content.steps[0].state).toStrictEqual({ lift: true });
    expect(updated.steps[0].state).toStrictEqual({ lift: true, demo: 0.6 });
  });

  it('sets numeric initial state without changing boolean values or mutating the input', () => {
    const content = makeContent();
    const updated = ops.setStartState(content, 'demo', 0.18);
    expect(updated.start).toStrictEqual({ lift: false, covers: true, demo: 0.18 });
    expect(ops.stateBeforeStep(updated, 'raise').demo).toBe(0.18);
    expect(content.start).toStrictEqual({ lift: false, covers: true });
  });

  it('sets initial state and patches metadata while preserving other fields', () => {
    const content = makeContent();
    const updated = ops.setStartState(content, 'lift', true);
    expect(updated.start).toStrictEqual({ lift: true, covers: true });
    expect(ops.patchMeta(content, { title: 'Edited', summary: 'Summary', minutes: 9 }))
      .toStrictEqual({ ...content, title: 'Edited', summary: 'Summary', minutes: 9 });
  });

  it('folds state through a step or only through its predecessor', () => {
    const content = makeContent();
    expect(ops.stateBeforeStep(content, 'raise')).toStrictEqual({ lift: false, covers: true });
    expect(ops.stateForStep(content, 'raise')).toStrictEqual({ lift: true, covers: true });
    expect(ops.stateBeforeStep(content, 'lower')).toStrictEqual({ lift: true, covers: false });
    expect(ops.stateForStep(content, 'lower')).toStrictEqual({ lift: false, covers: false });
    expect(ops.stateForStep(content, 'missing')).toStrictEqual(content.start);
    expect(ops.stateBeforeStep(content, 'missing')).toStrictEqual(content.start);
    expect(ops.stateBeforeStep(content, 'raise')).not.toBe(content.start);
    expect(ops.stepIndex(content, 'uncover')).toBe(1);
    expect(ops.stepIndex(content, 'missing')).toBe(-1);
  });

  it('ignores edits to unknown step ids', () => {
    const content = makeContent();
    expect(ops.removeStep(content, 'missing')).toBe(content);
    expect(ops.moveStep(content, 'missing', 1)).toBe(content);
    expect(ops.patchStep(content, 'missing', { title: 'Unknown' })).toBe(content);
    expect(ops.togglePart(content, 'missing', 'head')).toBe(content);
    expect(ops.setStepState(content, 'missing', 'lift', true)).toBe(content);
  });

  it('never mutates inputs and returns new content for edits', () => {
    const content = makeContent();
    const before = structuredClone(content);
    const viewBefore = structuredClone(view);
    const patch = { title: 'Edited', state: { covers: false }, parts: ['z'] };
    const patchBefore = structuredClone(patch);
    const results = [
      ops.addStepAfter(content, 'raise', view).content,
      ops.removeStep(content, 'uncover'),
      ops.moveStep(content, 'raise', 1),
      ops.patchStep(content, 'raise', patch),
      ops.togglePart(content, 'raise', 'z'),
      ops.setStepState(content, 'raise', 'lift', false),
      ops.setStepState(content, 'raise', 'lift', null),
      ops.setStartState(content, 'covers', false),
      ops.patchMeta(content, { title: 'Edited' }),
    ];
    ops.stateForStep(content, 'lower');
    ops.stateBeforeStep(content, 'lower');
    for (const result of results) expect(result).not.toBe(content);
    expect(content).toStrictEqual(before);
    expect(view).toStrictEqual(viewBefore);
    expect(patch).toStrictEqual(patchBefore);
  });
});

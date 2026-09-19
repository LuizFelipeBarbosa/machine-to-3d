import { describe, it, expect } from 'vitest';
import type { ProcedureContent, Step } from './procedure';
import { foldState } from './foldState';

function makeProcedure(): ProcedureContent {
  const steps: Pick<Step, 'id' | 'title' | 'state'>[] = [
    { id: 'raise', title: 'Raise the head', state: { lift: true } },
    { id: 'confirm', title: 'Confirm the head is raised', state: { lift: true } },
    { id: 'load', title: 'Load the sample', state: { sample: true } },
    { id: 'inspect', title: 'Inspect the sample' },
    { id: 'lower', title: 'Lower the head', state: { lift: false } },
  ];
  return {
    formatVersion: 1,
    title: 'Load an AFM sample',
    summary: 'Raise the head, load a sample, and lower the head.',
    minutes: 5,
    start: { lift: false, sample: false },
    steps: steps.map((step) => ({
      ...step,
      where: 'instrument',
      body: '',
      parts: ['head', 'z', 'sample'],
      view: { pos: [1, 1, 1], target: [0, 0, 0] },
    })),
  };
}

describe('foldState', () => {
  it('produces the same state when stepping one at a time or jumping to any step', () => {
    const content = makeProcedure();
    let state = { ...content.start };
    content.steps.forEach((step, stepIndex) => {
      state = foldState({ ...content, start: state, steps: [step] }, 0);
      expect(foldState(content, stepIndex)).toEqual(state);
    });
  });

  it('keeps repeated absolute true sets on, then applies a later false set', () => {
    const content = makeProcedure();
    expect(foldState(content, 0)).toEqual({ lift: true, sample: false });
    expect(foldState(content, 1)).toEqual({ lift: true, sample: false });
    expect(foldState(content, 4)).toEqual({ lift: false, sample: true });
  });

  it('preserves unmentioned variables and skips steps without state', () => {
    const content = makeProcedure();
    expect(foldState(content, 2)).toEqual({ lift: true, sample: true });
    expect(foldState(content, 3)).toEqual({ lift: true, sample: true });
  });

  it('returns a copy of start for a negative index', () => {
    const content = makeProcedure();
    const state = foldState(content, -1);
    expect(state).toEqual(content.start);
    expect(state).not.toBe(content.start);
  });

  it('treats an index past the end as the last step', () => {
    expect(foldState(makeProcedure(), 100)).toEqual({ lift: false, sample: true });
  });

  it('returns a copy of start when there are no steps', () => {
    const content = { ...makeProcedure(), steps: [] };
    const state = foldState(content, 0);
    expect(state).toEqual(content.start);
    expect(state).not.toBe(content.start);
  });

  it('does not mutate input and returns an independent state', () => {
    const content = makeProcedure();
    const original = makeProcedure();
    const state = foldState(content, 2);
    expect(content).toEqual(original);
    state.lift = false;
    state.sample = false;
    expect(content).toEqual(original);
  });
});

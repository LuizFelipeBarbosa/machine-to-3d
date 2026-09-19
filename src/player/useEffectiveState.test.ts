import { describe, it, expect } from 'vitest';
import type { ProcedureContent, Step } from '../../shared/procedure';
import { effectiveState } from './useEffectiveState';

function makeProcedure(): ProcedureContent {
  const steps: Pick<Step, 'id' | 'title' | 'state'>[] = [
    { id: 'inspect', title: 'Inspect the instrument' },
    { id: 'raise', title: 'Raise the head', state: { lift: true } },
    { id: 'cover', title: 'Replace the covers', state: { covers: true } },
    { id: 'confirm', title: 'Confirm the setup' },
  ];
  return {
    formatVersion: 1,
    title: 'Prepare the instrument',
    summary: 'Inspect and prepare the instrument.',
    minutes: 5,
    start: { covers: true, lift: false, sample: false },
    steps: steps.map((step) => ({
      ...step,
      where: 'instrument',
      body: '',
      parts: ['head'],
      view: { pos: [1, 1, 1], target: [0, 0, 0] },
    })),
  };
}

describe('effectiveState', () => {
  it('keeps an override across a subsequent step that does not mention it', () => {
    const content = makeProcedure();
    const overrides = { covers: false };
    expect(effectiveState(content, 0, overrides)).toEqual({ covers: false, lift: false, sample: false });
    expect(effectiveState(content, 1, overrides)).toEqual({ covers: false, lift: true, sample: false });
  });

  it('lets an explicit step state win only for the variables it sets', () => {
    const content = makeProcedure();
    const overrides = { covers: false, lift: false, sample: true };
    expect(effectiveState(content, 2, overrides)).toEqual({ covers: true, lift: false, sample: true });
    expect(overrides).toEqual({ covers: false, lift: false, sample: true });
    expect(content).toEqual(makeProcedure());
  });

  it('uses the folded state on first paint with no trainee overrides', () => {
    expect(effectiveState(makeProcedure(), 2, {})).toEqual({ covers: true, lift: true, sample: false });
  });
});

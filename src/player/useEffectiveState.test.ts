// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import type { ProcedureContent, Step } from '../../shared/procedure';
import { effectiveState, useEffectiveState } from './useEffectiveState';

afterEach(cleanup);

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

  it('retains numeric overrides until the current step explicitly sets the same variable', () => {
    const content = makeProcedure();
    content.start.demo = 0;
    content.steps[2].state = { covers: true, demo: 0.18 };
    const overrides = { demo: 0.6, sample: true };
    expect(effectiveState(content, 0, overrides).demo).toBe(0.6);
    expect(effectiveState(content, 1, overrides).demo).toBe(0.6);
    expect(effectiveState(content, 2, overrides)).toEqual({
      covers: true, lift: true, sample: true, demo: 0.18,
    });
    expect(overrides).toEqual({ demo: 0.6, sample: true });
  });
});

describe('useEffectiveState', () => {
  it('keeps numeric choices through navigation, clearing only variables set by an entered step', () => {
    const content = makeProcedure();
    content.start.demo = 0;
    content.steps[2].state = { covers: true, demo: 0.18 };
    const { result, rerender } = renderHook(({ index }) => useEffectiveState(content, index), {
      initialProps: { index: 0 },
    });

    act(() => {
      result.current.setValue('demo', 0.6);
      result.current.setValue('sample', true);
    });
    expect(result.current.state.demo).toBe(0.6);
    rerender({ index: 1 });
    expect(result.current.state.demo).toBe(0.6);
    rerender({ index: 2 });
    expect(result.current.state.demo).toBe(0.18);
    expect(result.current.state.sample).toBe(true);
    rerender({ index: 3 });
    expect(result.current.state.demo).toBe(0.18);

    rerender({ index: 2 });
    act(() => result.current.setValue('demo', 0));
    expect(result.current.state.demo).toBe(0);
    rerender({ index: 3 });
    expect(result.current.state.demo).toBe(0);
    rerender({ index: 2 });
    expect(result.current.state.demo).toBe(0.18);
    expect(content.start.demo).toBe(0);
  });
});

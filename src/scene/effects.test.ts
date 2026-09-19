import { describe, expect, it } from 'vitest';
import type { MachineDefinition, StateVar } from '../../shared/machine';
import { clipTimes, computePoses, easeValues, effectNodes, goalFromState } from './effects';
import type { RestTransform } from './effects';

function definition(stateVars: StateVar[]): MachineDefinition {
  return { formatVersion: 1, rootNode: 'Machine', parts: [], presetViews: [], stateVars };
}

function variable(name: string, effects: StateVar['effects']): StateVar {
  return { name, label: name, kind: 'toggle', effects };
}

const rest: Record<string, RestTransform> = {
  Arm: { position: [1, 2, 3], quaternion: [0, 0, 0, 1] },
  Unrelated: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
};

describe('goalFromState', () => {
  it.each([
    { value: true, expected: 1 },
    { value: false, expected: 0 },
    { value: undefined, expected: 0 },
    { value: 0.18, expected: 0.18 },
    { value: -0.5, expected: 0 },
    { value: 1.5, expected: 1 },
    { value: NaN, expected: 0 },
  ])('maps $value to $expected', ({ value, expected }) => {
    expect(goalFromState(value)).toBe(expected);
  });
});

describe('easeValues', () => {
  it('moves toward goals without mutating input or overshooting, then snaps exactly', () => {
    const initial = { rising: 0, falling: 1 };
    const goals = { rising: true, falling: false };
    let values = easeValues(initial, goals, 1 / 60);
    expect(values.rising).toBeGreaterThan(0);
    expect(values.falling).toBeLessThan(1);
    expect(initial).toEqual({ rising: 0, falling: 1 });
    for (let step = 0; step < 1000; step += 1) {
      const next = easeValues(values, goals, 1 / 60);
      expect(next.rising).toBeGreaterThanOrEqual(values.rising);
      expect(next.rising).toBeLessThanOrEqual(1);
      expect(next.falling).toBeLessThanOrEqual(values.falling);
      expect(next.falling).toBeGreaterThanOrEqual(0);
      values = next;
    }
    expect(values).toEqual({ rising: 1, falling: 0 });
  });

  it('moves toward numeric goals without mutating input or overshooting, then snaps exactly', () => {
    const initial = { rising: 0, falling: 1 };
    const goals = { rising: 0.6, falling: 0.6 };
    let values = easeValues(initial, goals, 1 / 60);
    expect(values.rising).toBeGreaterThan(0);
    expect(values.falling).toBeLessThan(1);
    expect(initial).toEqual({ rising: 0, falling: 1 });
    for (let step = 0; step < 1000; step += 1) {
      const next = easeValues(values, goals, 1 / 60);
      expect(next.rising).toBeGreaterThanOrEqual(values.rising);
      expect(next.rising).toBeLessThanOrEqual(0.6);
      expect(next.falling).toBeLessThanOrEqual(values.falling);
      expect(next.falling).toBeGreaterThanOrEqual(0.6);
      values = next;
    }
    expect(values).toEqual({ rising: 0.6, falling: 0.6 });
    expect(goals).toEqual({ rising: 0.6, falling: 0.6 });
  });

  it('clamps numeric goals and mixes numeric and boolean goals', () => {
    const goals = { high: 2, low: -1, zero: 0, fraction: 0.6, on: true, off: false };
    const initial = { high: 0, low: 1, zero: 1, fraction: 0, on: 0, off: 1 };
    const values = easeValues(initial, goals, 1 / 60);
    expect(values.high).toBeGreaterThan(0);
    expect(values.high).toBeLessThan(1);
    expect(values.low).toBeGreaterThan(0);
    expect(values.low).toBeLessThan(1);
    expect(easeValues(initial, goals, 100)).toEqual({
      high: 1, low: 0, zero: 0, fraction: 0.6, on: 1, off: 0,
    });
    expect(goals.high).toBe(2);
    expect(goals.low).toBe(-1);
  });

  it('handles absent values, negative time, and large time steps', () => {
    expect(easeValues({}, { on: true }, 0)).toEqual({ on: 0 });
    expect(easeValues({ on: 0.3 }, { on: true }, -1)).toEqual({ on: 0.3 });
    expect(easeValues({ on: -2, off: 3 }, { on: true, off: false }, 100)).toEqual({ on: 1, off: 0 });
  });
});

describe('clipTimes', () => {
  const clips = definition([
    variable('open', [
      { type: 'clip', clip: 'OpenDoor' },
      { type: 'translate', node: 'Arm', offset: [4, 5, 6] },
      { type: 'clip', clip: 'RaiseHead' },
    ]),
    variable('load', [{ type: 'clip', clip: 'LoadSample' }]),
  ]);
  const durations = { OpenDoor: 4, RaiseHead: 2, LoadSample: 6 };

  it.each([
    [0, 0], [1, 4], [0.5, 2], [-1, 0], [2, 4],
  ])('maps value %s to time %s, clamping before multiplying', (value, time) => {
    expect(clipTimes(clips, { open: value, load: 0.5 }, durations)).toEqual({
      OpenDoor: time,
      RaiseHead: time / 2,
      LoadSample: 3,
    });
  });

  it('defaults missing values to zero and accepts zero-duration clips', () => {
    expect(clipTimes(clips, {}, durations)).toEqual({ OpenDoor: 0, RaiseHead: 0, LoadSample: 0 });
    expect(clipTimes(clips, { open: 1 }, { ...durations, OpenDoor: 0 })).toEqual({
      OpenDoor: 0, RaiseHead: 2, LoadSample: 0,
    });
  });

  it('throws when a referenced clip has no known duration, even with no state value', () => {
    expect(() => clipTimes(clips, {}, { RaiseHead: 2, LoadSample: 6 })).toThrow(
      new Error('Unknown clip "OpenDoor"'),
    );
  });

  it('returns no times when there are no clip effects', () => {
    const machine = definition([variable('open', [{ type: 'visible', node: 'Arm' }])]);
    expect(clipTimes(machine, { open: 1 }, durations)).toEqual({});
  });
});

describe('computePoses', () => {
  const translate = definition([
    variable('open', [{ type: 'translate', node: 'Arm', offset: [4, 5, 6] }]),
    variable('lift', [{ type: 'translate', node: 'Arm', offset: [0, 2, 0] }]),
  ]);

  it('returns rest at zero and full additive translations at one', () => {
    expect(computePoses(translate, { open: 0 }, rest).Arm.position).toEqual([1, 2, 3]);
    expect(computePoses(translate, { open: 1 }, rest).Arm.position).toEqual([5, 7, 9]);
    expect(computePoses(translate, { open: 1, lift: 1 }, rest).Arm.position).toEqual([5, 9, 9]);
    expect(rest.Arm.position).toEqual([1, 2, 3]);
  });

  it('deduplicates effect nodes and excludes unrelated nodes', () => {
    expect(effectNodes(translate)).toEqual(['Arm']);
    expect(Object.keys(computePoses(translate, {}, rest))).toEqual(['Arm']);
    expect(computePoses(translate, {}, rest).Arm.visible).toBe(true);
  });

  it('ignores clip effects when collecting effect nodes', () => {
    const machine = definition([
      variable('open', [
        { type: 'clip', clip: 'OpenDoor' },
        { type: 'translate', node: 'Arm', offset: [4, 5, 6] },
        { type: 'clip', clip: 'RaiseHead' },
      ]),
    ]);
    expect(effectNodes(machine)).toEqual(['Arm']);
  });

  it.each([0, 0.5, 1])('ignores clip effects when computing poses at value %s', (value) => {
    const machine = definition([variable('open', [
      { type: 'translate', node: 'Arm', offset: [4, 5, 6] },
      { type: 'rotate', node: 'Arm', axis: 'y', angle: Math.PI / 2 },
      { type: 'visible', node: 'Arm' },
    ])]);
    const expected = computePoses(machine, { open: value }, rest);
    machine.stateVars[0].effects.unshift({ type: 'clip', clip: 'OpenDoor' });
    expect(computePoses(machine, { open: value }, rest)).toEqual(expected);
    expect(Object.keys(expected)).toEqual(['Arm']);
  });

  it('rotates pi/2 about y', () => {
    const rotated = definition([variable('turn', [{ type: 'rotate', node: 'Arm', axis: 'y', angle: Math.PI / 2 }])]);
    const quaternion = computePoses(rotated, { turn: 1 }, rest).Arm.quaternion;
    expect(quaternion[0]).toBe(0);
    expect(quaternion[1]).toBeCloseTo(Math.SQRT1_2);
    expect(quaternion[2]).toBe(0);
    expect(quaternion[3]).toBeCloseTo(Math.SQRT1_2);
  });

  it('composes rotations after the rest quaternion in authored order', () => {
    const rotated = definition([variable('turn', [
      { type: 'rotate', node: 'Arm', axis: 'y', angle: Math.PI / 2 },
      { type: 'rotate', node: 'Arm', axis: 'z', angle: Math.PI / 2 },
    ])]);
    const rotatedRest: Record<string, RestTransform> = {
      Arm: { position: [0, 0, 0], quaternion: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
    };
    const result = computePoses(rotated, { turn: 1 }, rotatedRest).Arm.quaternion;
    [Math.SQRT1_2, 0, Math.SQRT1_2, 0].forEach((value, index) => {
      expect(result[index]).toBeCloseTo(value);
    });
  });

  it('requires every visibility effect to exceed the midpoint', () => {
    const visible = definition([
      variable('a', [{ type: 'visible', node: 'Arm' }]),
      variable('b', [{ type: 'visible', node: 'Arm' }]),
    ]);
    expect(computePoses(visible, { a: 0, b: 1 }, rest).Arm.visible).toBe(false);
    expect(computePoses(visible, { a: 1, b: 0.5 }, rest).Arm.visible).toBe(false);
    expect(computePoses(visible, { a: 1, b: 0.51 }, rest).Arm.visible).toBe(true);
  });
});

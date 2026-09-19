import { describe, expect, it } from 'vitest';
import type { MachineDefinition, StateVar } from '../../shared/machine';
import { computePoses, easeValues, effectNodes } from './effects';
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

  it('handles absent values, negative time, and large time steps', () => {
    expect(easeValues({}, { on: true }, 0)).toEqual({ on: 0 });
    expect(easeValues({ on: 0.3 }, { on: true }, -1)).toEqual({ on: 0.3 });
    expect(easeValues({ on: -2, off: 3 }, { on: true, off: false }, 100)).toEqual({ on: 1, off: 0 });
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

import { describe, it, expect } from 'vitest';
import { MachineDefinitionSchema, StateVarSchema } from './machine';
import type { StateVar } from './machine';

const fraction: StateVar = {
  name: 'demo',
  label: 'Demonstration progress',
  kind: 'fraction',
  userToggle: true,
  effects: [
    { type: 'clip', clip: 'Demonstration' },
    { type: 'translate', node: 'Arm', offset: [0, 1, 0] },
    { type: 'rotate', node: 'Arm', axis: 'y', angle: Math.PI },
    { type: 'visible', node: 'Cover' },
  ],
};

describe('fraction state variables', () => {
  it('parses a fraction with every effect type', () => {
    expect(StateVarSchema.parse(fraction)).toEqual(fraction);
  });

  it('parses a machine containing both toggles and fractions', () => {
    const machine = {
      formatVersion: 1,
      rootNode: 'Camera',
      parts: [],
      presetViews: [],
      stateVars: [
        fraction,
        { name: 'cover', label: 'Cover', kind: 'toggle', effects: [{ type: 'visible', node: 'Cover' }] },
      ],
    };
    expect(MachineDefinitionSchema.parse(machine)).toEqual(machine);
  });
});

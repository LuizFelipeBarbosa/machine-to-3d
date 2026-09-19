import { useRef, useState } from 'react';
import type { MachineDefinition, MachineState } from '../../shared/machine';
import type { MachineSceneHandle } from '../scene';

export function useSceneController(definition: MachineDefinition) {
  const handle = useRef<MachineSceneHandle>(null);
  const [state, setState] = useState<MachineState>(() => Object.fromEntries(
    definition.stateVars.map((variable) => [
      variable.name,
      variable.effects.every((effect) => effect.type === 'visible'),
    ]),
  ));
  const [highlighted, setHighlighted] = useState<string[]>([]);

  return { handle, state, setState, highlighted, setHighlighted };
}

export type SceneController = ReturnType<typeof useSceneController>;

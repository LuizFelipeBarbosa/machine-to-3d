import { useMemo, useState } from 'react';
import { foldState } from '../../shared/foldState';
import type { MachineState } from '../../shared/machine';
import type { ProcedureContent } from '../../shared/procedure';

function retainedOverrides(content: ProcedureContent, index: number, overrides: MachineState): MachineState {
  const stepState = content.steps[index]?.state ?? {};
  return Object.fromEntries(
    Object.entries(overrides).filter(([name]) => !Object.hasOwn(stepState, name)),
  );
}

export function effectiveState(content: ProcedureContent, index: number, overrides: MachineState): MachineState {
  return { ...foldState(content, index), ...retainedOverrides(content, index, overrides) };
}

/** Keep trainee choices until an entered step explicitly sets the same variable. */
export function useEffectiveState(content: ProcedureContent, index: number): {
  state: MachineState;
  setValue(name: string, value: boolean | number): void;
} {
  const [overrides, setOverrides] = useState<MachineState>({});
  const [previousStep, setPreviousStep] = useState({ content, index });

  // Adjust before committing children so neither the scene nor later steps see stale choices.
  // Overrides made after entering this step are allowed, even if it sets that variable.
  if (previousStep.content !== content || previousStep.index !== index) {
    setPreviousStep({ content, index });
    setOverrides(previousStep.content !== content ? {} : retainedOverrides(content, index, overrides));
  }

  const state = useMemo(() => ({ ...foldState(content, index), ...overrides }), [content, index, overrides]);

  return {
    state,
    setValue(name, value) {
      setOverrides((current) => ({ ...current, [name]: value }));
    },
  };
}

import type { JSX } from 'react';
import type { MachineState, StateVar } from '../../shared/machine';

type StepStateControlsProps = {
  stateVars: StateVar[];
  state: MachineState | undefined;
  inherited: MachineState;
  onChange(name: string, value: boolean | null): void;
};

const choices = [
  { label: 'Inherit', value: null },
  { label: 'On', value: true },
  { label: 'Off', value: false },
] as const;

export function StepStateControls({ stateVars, state, inherited, onChange }: StepStateControlsProps): JSX.Element {
  return (
    <fieldset className="editor-fieldset">
      <legend>Machine state</legend>
      {stateVars.length === 0 && <p className="editor-hint">This machine has no state controls.</p>}
      {stateVars.map((variable) => {
        const value = state?.[variable.name] ?? null;
        const inheritedValue = Boolean(inherited[variable.name]);
        return (
          <div className="editor-state" key={variable.name}>
            <span>{variable.label}</span>
            <small className="editor-hint">inherits: {inheritedValue ? 'on' : 'off'}</small>
            <div className="tri" role="group" aria-label={variable.label}>
              {choices.map((choice) => (
                <button
                  key={choice.label}
                  type="button"
                  aria-pressed={value === choice.value}
                  onClick={() => onChange(variable.name, choice.value)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            {value !== null && value === inheritedValue && (
              <small className="editor-hint">same as inherited (no-op)</small>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

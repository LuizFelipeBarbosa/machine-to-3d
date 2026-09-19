import type { JSX } from 'react';
import type { MachineState, StateVar } from '../../shared/machine';

type StepStateControlsProps = {
  stateVars: StateVar[];
  state: MachineState | undefined;
  inherited: MachineState;
  onChange(name: string, value: boolean | number | null): void;
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
        const inheritedValue = variable.kind === 'fraction'
          ? Number(inherited[variable.name] ?? 0)
          : Boolean(inherited[variable.name]);
        return (
          <div className="editor-state" key={variable.name}>
            <span>{variable.label}</span>
            <small className="editor-hint">
              inherits: {typeof inheritedValue === 'number' ? inheritedValue : inheritedValue ? 'on' : 'off'}
            </small>
            <div className="tri" role="group" aria-label={variable.label}>
              {variable.kind === 'fraction' ? (
                <>
                  <button
                    type="button"
                    aria-pressed={value === null}
                    onClick={() => onChange(variable.name, null)}
                  >
                    Inherit
                  </button>
                  <input
                    type="number"
                    aria-label={variable.label}
                    min={0}
                    max={1}
                    step={0.01}
                    value={Number(value ?? inheritedValue)}
                    onChange={(event) => {
                      const next = event.target.valueAsNumber;
                      if (Number.isFinite(next)) {
                        onChange(variable.name, Math.max(0, Math.min(1, next)));
                      }
                    }}
                  />
                </>
              ) : choices.map((choice) => (
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

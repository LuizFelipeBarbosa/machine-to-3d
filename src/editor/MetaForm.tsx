import type { JSX } from 'react';
import type { StateVar } from '../../shared/machine';
import type { ProcedureContent } from '../../shared/procedure';

type MetaFormProps = {
  content: ProcedureContent;
  stateVars: StateVar[];
  onPatch(patch: Partial<Pick<ProcedureContent, 'title' | 'summary' | 'minutes'>>): void;
  onSetStartState(name: string, value: boolean | number): void;
};

export function MetaForm({ content, stateVars, onPatch, onSetStartState }: MetaFormProps): JSX.Element {
  return (
    <details className="editor-meta">
      <summary>Procedure details</summary>
      <div className="editor-fields">
        <label className="editor-field">
          Procedure title
          <input value={content.title} onChange={(event) => onPatch({ title: event.target.value })} />
        </label>
        <label className="editor-field">
          Summary
          <textarea rows={3} value={content.summary} onChange={(event) => onPatch({ summary: event.target.value })} />
        </label>
        <label className="editor-field">
          Minutes
          <input type="number" min={1} step={1} value={content.minutes || ''}
            onChange={(event) => onPatch({ minutes: Number(event.target.value) })} />
        </label>
        <fieldset className="editor-fieldset">
          <legend>Starting state</legend>
          {stateVars.map((variable) => (
            <label className="editor-checkbox" key={variable.name}>
              {variable.kind === 'fraction' ? (
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={Number(content.start[variable.name] ?? 0)}
                  onChange={(event) => {
                    const value = event.target.valueAsNumber;
                    if (Number.isFinite(value)) {
                      onSetStartState(variable.name, Math.max(0, Math.min(1, value)));
                    }
                  }}
                />
              ) : (
                <input type="checkbox" checked={Boolean(content.start[variable.name])}
                  onChange={(event) => onSetStartState(variable.name, event.target.checked)} />
              )}
              {variable.label}
            </label>
          ))}
          {stateVars.length === 0 && <p className="editor-hint">This machine has no state controls.</p>}
        </fieldset>
      </div>
    </details>
  );
}

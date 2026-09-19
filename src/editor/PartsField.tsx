import type { JSX } from 'react';
import type { Part } from '../../shared/machine';

type PartsFieldProps = {
  parts: Part[];
  selected: string[];
  onToggle(name: string): void;
};

export function PartsField({ parts, selected, onToggle }: PartsFieldProps): JSX.Element {
  return (
    <fieldset className="editor-fieldset">
      <legend>Parts</legend>
      <p className="editor-hint">Click the model to add or remove a part.</p>
      <div className="editor-chips">
        {selected.map((name) => {
          const label = parts.find((part) => part.name === name)?.label ?? name;
          return (
            <span className="chip" key={name}>
              {label}
              <button type="button" aria-label={`Remove ${label}`} onClick={() => onToggle(name)}>×</button>
            </span>
          );
        })}
        {selected.length === 0 && <span className="editor-hint">No parts selected</span>}
      </div>
      <label className="editor-field">
        Add part by name
        <select value="" onChange={(event) => {
          if (event.target.value) onToggle(event.target.value);
        }}>
          <option value="">Choose a part…</option>
          {parts.filter((part) => !selected.includes(part.name)).map((part) => (
            <option key={part.name} value={part.name}>{part.label} ({part.name})</option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

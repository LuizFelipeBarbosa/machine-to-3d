import type { JSX } from 'react';
import type { Part } from '../../shared/machine';
import type { Step } from '../../shared/procedure';

type PartInspectorProps = {
  part: Part;
  steps: Step[];
  onGo(index: number): void;
  onClose(): void;
};

export function PartInspector({ part, steps, onGo, onClose }: PartInspectorProps): JSX.Element {
  const usedIn = steps.flatMap((step, index) => step.parts.includes(part.name) ? [index] : []);

  return (
    <div className="inspect">
      <button type="button" className="close" aria-label="Close part details" onClick={onClose}>×</button>
      <h2>{part.label}</h2>
      <p>{part.blurb}</p>
      <div className="uses">
        {usedIn.length === 0 ? 'Not used in this procedure' : `Used in step${usedIn.length > 1 ? 's' : ''}`}
        {usedIn.map((index) => (
          <button type="button" key={index} aria-label={`Go to step ${index + 1}`} onClick={() => onGo(index)}>
            {index + 1}
          </button>
        ))}
      </div>
    </div>
  );
}

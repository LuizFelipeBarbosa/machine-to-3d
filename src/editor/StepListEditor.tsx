import type { JSX } from 'react';
import type { Step } from '../../shared/procedure';

type StepListEditorProps = {
  steps: Step[];
  selectedId: string | null;
  canAdd: boolean;
  onSelect(id: string): void;
  onAdd(afterId: string | null): void;
  onRemove(id: string): void;
  onMove(id: string, direction: -1 | 1): void;
};

export function StepListEditor({ steps, selectedId, canAdd, onSelect, onAdd, onRemove, onMove }: StepListEditorProps): JSX.Element {
  return (
    <section className="editor-step-list" aria-label="Procedure steps">
      <h3>Steps</h3>
      <ol className="steps editor-steps">
        {steps.map((step, index) => {
          const current = step.id === selectedId;
          return (
            <li key={step.id} className={`step editor-step${current ? ' is-current' : ''}`} aria-current={current ? 'step' : undefined}>
              <button type="button" className="step-head editor-step-select" onClick={() => onSelect(step.id)}>
                <span className="num">{index + 1}</span>
                <span className="editor-step-label">
                  <span className="step-title editor-step-title" title={step.title}>{step.title || 'Untitled step'}</span>
                  <span className="editor-badges">
                    {step.check && <span className="editor-badge">Checkpoint</span>}
                    {step.link && <span className="editor-badge">Link</span>}
                  </span>
                </span>
              </button>
              <div className="editor-step-actions">
                <button type="button" className="btn" aria-label={`Move step ${index + 1} up`}
                  disabled={index === 0} onClick={() => onMove(step.id, -1)}>▲</button>
                <button type="button" className="btn" aria-label={`Move step ${index + 1} down`}
                  disabled={index === steps.length - 1} onClick={() => onMove(step.id, 1)}>▼</button>
                <button type="button" className="btn" aria-label={`Remove step ${index + 1}`}
                  disabled={steps.length <= 1} onClick={() => onRemove(step.id)}>✕</button>
              </div>
            </li>
          );
        })}
      </ol>
      <button type="button" className="btn" disabled={!canAdd} onClick={() => onAdd(selectedId)}>
        {selectedId ? '+ Add step after' : '+ Add step'}
      </button>
    </section>
  );
}

import type { JSX, Ref } from 'react';
import type { Step, StepLocation } from '../../shared/procedure';
import type { Progress } from './playerStore';
import { StepBody } from './StepBody';

const locationLabels: Record<StepLocation, string> = {
  instrument: 'At the instrument',
  software: 'In the control software',
  logbook: 'In the logbook',
};

type StepListProps = {
  steps: Step[];
  progress: Progress;
  currentRowRef: Ref<HTMLLIElement>;
  linkTargets: Record<string, string[]>;
  onGo(index: number): void;
  onChecked(stepId: string, checked: boolean): void;
  onOpenProcedure(procedureSlug: string, stepId?: string): void;
};

export function StepList({ steps, progress, currentRowRef, linkTargets, onGo, onChecked, onOpenProcedure }: StepListProps): JSX.Element {
  return (
    <ol className="steps">
      {steps.map((step, index) => {
        const current = index === progress.cur;
        const done = progress.done.includes(step.id);
        const className = ['step', current && 'is-current', done && 'is-done'].filter(Boolean).join(' ');
        return (
          <li key={step.id} className={className} aria-current={current ? 'step' : undefined} ref={current ? currentRowRef : undefined}>
            <button type="button" className="step-head" onClick={() => onGo(index)}>
              <span className="num">{index + 1}</span>
              <span>
                <span className="step-title">{step.title}</span>
                <span className="step-where">{locationLabels[step.where]}</span>
              </span>
              <span className="step-flag">{done ? 'Done' : step.check ? 'Checkpoint' : ''}</span>
            </button>
            {current && (
              <StepBody
                step={step}
                checked={progress.checked.includes(step.id)}
                onChecked={(checked) => onChecked(step.id, checked)}
                linkTargets={linkTargets}
                onOpenProcedure={onOpenProcedure}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

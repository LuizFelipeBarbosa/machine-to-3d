import type { JSX } from 'react';

type PlayerFooterProps = {
  index: number;
  stepCount: number;
  nextDisabled: boolean;
  onBack(): void;
  onNext(): void;
};

export function PlayerFooter({ index, stepCount, nextDisabled, onBack, onNext }: PlayerFooterProps): JSX.Element {
  return (
    <div className="panel-foot">
      <button type="button" className="btn" disabled={index === 0} onClick={onBack}>Back</button>
      <span className="panel-count">{index >= stepCount ? 'Complete' : `Step ${index + 1} of ${stepCount}`}</span>
      <button type="button" className="btn primary" disabled={nextDisabled} onClick={onNext}>
        {index >= stepCount - 1 ? 'Finish procedure' : 'Next step'}
      </button>
    </div>
  );
}

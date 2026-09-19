import type { JSX } from 'react';
import type { Step } from '../../shared/procedure';

type StepBodyProps = {
  step: Step;
  checked: boolean;
  onChecked(checked: boolean): void;
  linkTargets: Record<string, string[]>;
  mediaUrls?: Record<string, string>;
  onOpenProcedure(procedureSlug: string, stepId?: string): void;
};

function looksLikeUrl(value: string): boolean {
  return /^(https?:\/\/|\/|blob:)/i.test(value);
}

export function StepBody({ step, checked, onChecked, linkTargets, mediaUrls, onOpenProcedure }: StepBodyProps): JSX.Element {
  const link = step.link;
  const targetSteps = link ? linkTargets[link.procedureSlug] : undefined;
  const mediaUrl = step.media && (mediaUrls?.[step.media.fileId]
    ?? (looksLikeUrl(step.media.fileId) ? step.media.fileId : undefined));

  function openLinkedProcedure(): void {
    if (!link || !targetSteps) return;
    const stepId = link.stepId && targetSteps.includes(link.stepId) ? link.stepId : undefined;
    onOpenProcedure(link.procedureSlug, stepId);
  }

  return (
    <div className="step-body">
      <p>{step.body}</p>
      {step.caution && (
        <div className="caution">
          <strong>Where this goes wrong</strong>
          {step.caution}
        </div>
      )}
      {step.check && (
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(event) => onChecked(event.target.checked)} />
          <span>{step.check}<small>Confirm this to continue</small></span>
        </label>
      )}
      {link && (
        <button
          type="button"
          className="jump"
          disabled={targetSteps === undefined}
          title={targetSteps === undefined ? 'Not available' : undefined}
          onClick={openLinkedProcedure}
        >
          {link.label}
        </button>
      )}
      {step.media && mediaUrl && <img className="step-media" src={mediaUrl} alt={step.media.alt} />}
    </div>
  );
}

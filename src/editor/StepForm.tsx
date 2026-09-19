import type { JSX } from 'react';
import type { MachineDefinition, MachineState } from '../../shared/machine';
import type { Step, StepLocation } from '../../shared/procedure';
import type { MachineSceneHandle } from '../scene';
import { PartsField } from './PartsField';
import { StepStateControls } from './StepStateControls';
import { ViewCapture } from './ViewCapture';

type StepFormProps = {
  step: Step;
  machine: MachineDefinition;
  inherited: MachineState;
  linkTargets: Record<string, string[]>;
  procedureTitles?: Record<string, string>;
  scene: MachineSceneHandle | null;
  onPatch(patch: Partial<Omit<Step, 'id'>>): void;
  onTogglePart(name: string): void;
  onSetState(name: string, value: boolean | null): void;
};

export function StepForm({ step, machine, inherited, linkTargets, procedureTitles, scene, onPatch, onTogglePart, onSetState }: StepFormProps): JSX.Element {
  const link = step.link;
  const targetSteps = link ? linkTargets[link.procedureSlug] ?? [] : [];

  return (
    <section className="editor-step-form editor-fields" aria-label="Selected step">
      <h3>Edit step</h3>
      <label className="editor-field">
        Step title
        <input value={step.title} onChange={(event) => onPatch({ title: event.target.value })} />
      </label>
      <label className="editor-field">
        Where
        <select value={step.where} onChange={(event) => onPatch({ where: event.target.value as StepLocation })}>
          <option value="instrument">At the instrument</option>
          <option value="software">In the control software</option>
          <option value="logbook">In the logbook</option>
        </select>
      </label>
      <label className="editor-field">
        Body
        <textarea rows={5} value={step.body} onChange={(event) => onPatch({ body: event.target.value })} />
      </label>
      <label className="editor-field">
        Caution (optional)
        <textarea rows={3} value={step.caution ?? ''} onChange={(event) => onPatch({ caution: event.target.value || undefined })} />
      </label>
      <label className="editor-field">
        Checkpoint text (optional)
        <input value={step.check ?? ''} onChange={(event) => onPatch({ check: event.target.value || undefined })} />
      </label>
      <fieldset className="editor-fieldset">
        <legend>Link to another procedure</legend>
        <label className="editor-field">
          Procedure
          <select value={link?.procedureSlug ?? ''} onChange={(event) => {
            const procedureSlug = event.target.value;
            onPatch({
              link: procedureSlug ? {
                procedureSlug,
                label: procedureTitles?.[procedureSlug] ?? procedureSlug,
              } : undefined,
            });
          }}>
            <option value="">No link</option>
            {link && !Object.hasOwn(linkTargets, link.procedureSlug) && (
              <option value={link.procedureSlug}>{link.procedureSlug} (unavailable)</option>
            )}
            {Object.keys(linkTargets).map((slug) => (
              <option key={slug} value={slug}>{procedureTitles?.[slug] ?? slug}</option>
            ))}
          </select>
        </label>
        {link && (
          <>
            <label className="editor-field">
              Linked step
              <select value={link.stepId ?? ''} onChange={(event) => {
                const updated = { ...link };
                if (event.target.value) updated.stepId = event.target.value;
                else delete updated.stepId;
                onPatch({ link: updated });
              }}>
                <option value="">Start of procedure</option>
                {link.stepId && !targetSteps.includes(link.stepId) && (
                  <option value={link.stepId}>{link.stepId} (unavailable)</option>
                )}
                {targetSteps.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
            <label className="editor-field">
              Link label
              <input value={link.label} onChange={(event) => onPatch({ link: { ...link, label: event.target.value } })} />
            </label>
            <button type="button" className="btn" onClick={() => onPatch({ link: undefined })}>Remove link</button>
          </>
        )}
      </fieldset>
      <PartsField parts={machine.parts} selected={step.parts} onToggle={onTogglePart} />
      <ViewCapture view={step.view} presets={machine.presetViews} scene={scene} onCapture={(view) => onPatch({ view })} />
      <StepStateControls stateVars={machine.stateVars} state={step.state} inherited={inherited} onChange={onSetState} />
    </section>
  );
}

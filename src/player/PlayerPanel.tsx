import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { createPortal } from 'react-dom';
import type { MachineRecord, ProcedureRecord } from '../data/catalog';
import type { SceneController } from '../machine/useSceneController';
import { PartInspector } from './PartInspector';
import { PlayerFooter } from './PlayerFooter';
import { StepList } from './StepList';
import { usePlayerStore } from './playerStore';
import type { Progress } from './playerStore';
import { useEffectiveState } from './useEffectiveState';

export type PlayerPanelProps = {
  machine: MachineRecord;
  controller: SceneController;
  /** Portal targets keep player controls beside the scene without moving player state into the workspace. */
  viewport?: { tools: HTMLDivElement | null; inspector: HTMLDivElement | null };
  inspected?: string | null;
  onInspect?(part: string | null): void;
  procedure: ProcedureRecord;
  linkTargets: Record<string, string[]>;
  onOpenProcedure(procedureSlug: string, stepId?: string): void;
  initialStepId?: string;
  mediaUrls?: Record<string, string>;
  preview?: boolean;
  onComplete?(checkpoints: { stepId: string; at: number }[]): void;
};

function isTextControl(target: EventTarget | null): boolean {
  return target instanceof Element && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
}

export function PlayerPanel({
  machine, controller, viewport, inspected, onInspect, procedure, linkTargets,
  onOpenProcedure, initialStepId, onComplete, mediaUrls, preview = false,
}: PlayerPanelProps): JSX.Element {
  const { content } = procedure;
  const { steps } = content;
  const progressKey = `${machine.slug}/${procedure.slug}`;
  // Select the stored entry, not get(): its fresh default is not a stable store snapshot.
  const savedProgress = usePlayerStore((store) => store.progress[progressKey]);
  const [initialIndex] = useState(() => {
    const requestedIndex = steps.findIndex((step) => step.id === initialStepId);
    const index = requestedIndex >= 0 ? requestedIndex : preview ? 0 : usePlayerStore.getState().get(progressKey).cur;
    return Math.max(0, Math.min(index, steps.length));
  });
  const [initialized, setInitialized] = useState(false);
  const [previewProgress, setPreviewProgress] = useState<Progress>({ cur: initialIndex, done: [], checked: [] });
  const progressState = preview ? previewProgress : savedProgress;
  const index = initialized ? Math.max(0, Math.min(progressState?.cur ?? 0, steps.length)) : initialIndex;
  const progress = { cur: index, done: progressState?.done ?? [], checked: progressState?.checked ?? [] };
  const currentStep = steps[index];
  const sceneStep = steps[Math.min(index, steps.length - 1)];
  const { state, setToggle } = useEffectiveState(content, index);
  const setInspected = useCallback((part: string | null) => onInspect?.(part), [onInspect]);
  const inspectedPart = machine.definition.parts.find((part) => part.name === inspected);
  const { handle: scene, setState, setHighlighted } = controller;
  const currentRow = useRef<HTMLLIElement>(null);
  const synchronizedStep = useRef<{ index: number; content: typeof content } | null>(null);
  const completionReported = useRef(false);
  const nextDisabled = !currentStep || Boolean(currentStep.check && !progress.checked.includes(currentStep.id));
  const announcement = currentStep ? `Step ${index + 1} of ${steps.length}: ${currentStep.title}` : 'Procedure complete';

  useLayoutEffect(() => {
    setState(state);
  }, [state, setState]);

  useLayoutEffect(() => {
    const parts = [...(sceneStep?.parts ?? [])];
    if (inspectedPart && !parts.includes(inspectedPart.name)) parts.push(inspectedPart.name);
    setHighlighted(parts);
  }, [sceneStep, inspectedPart, setHighlighted]);

  useLayoutEffect(() => () => {
    setHighlighted([]);
    setInspected(null);
  }, [setHighlighted, setInspected]);

  useEffect(() => {
    if (!preview) usePlayerStore.getState().go(progressKey, initialIndex, steps.length);
    setInitialized(true);
  }, [preview, progressKey, initialIndex, steps.length]);

  useEffect(() => {
    if (preview || index < steps.length || completionReported.current) return;
    completionReported.current = true;
    const at = Date.now();
    onComplete?.((savedProgress?.checked ?? []).map((stepId) => ({ stepId, at })));
  }, [preview, index, steps.length, savedProgress?.checked, onComplete]);

  const syncStepView = useCallback((instant = false) => {
    if (sceneStep) scene.current?.goToView(sceneStep.view, { instant });
  }, [scene, sceneStep]);

  useEffect(function synchronizeCurrentStep() {
    const previous = synchronizedStep.current;
    if (previous?.index === index && previous.content === content) return;
    let frame: number | undefined;
    function synchronizeView() {
      // Canvas mounts in a separate React root; its handle may arrive after this panel.
      if (!scene.current) {
        frame = requestAnimationFrame(synchronizeView);
        return;
      }
      syncStepView(previous === null);
      synchronizedStep.current = { index, content };
    }
    synchronizeView();
    setInspected(null);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    currentRow.current?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [content, index, scene, syncStepView, setInspected]);

  const go = useCallback((nextIndex: number) => {
    setInspected(null);
    if (preview) {
      setPreviewProgress((progress) => ({ ...progress, cur: Math.max(0, Math.min(nextIndex, steps.length)) }));
    } else {
      usePlayerStore.getState().go(progressKey, nextIndex, steps.length);
    }
  }, [preview, progressKey, steps.length, setInspected]);

  const requestedStep = useRef(initialStepId);
  useEffect(() => {
    if (requestedStep.current === initialStepId) return;
    requestedStep.current = initialStepId;
    const requestedIndex = steps.findIndex((step) => step.id === initialStepId);
    if (requestedIndex >= 0) go(requestedIndex);
  }, [initialStepId, steps, go]);

  const back = useCallback(() => {
    if (index > 0) go(index - 1);
  }, [go, index]);

  const next = useCallback(() => {
    if (nextDisabled || !currentStep) return;
    setInspected(null);
    if (preview) {
      setPreviewProgress((progress) => ({
        ...progress,
        cur: Math.min(progress.cur + 1, steps.length),
        done: progress.done.includes(currentStep.id) ? progress.done : [...progress.done, currentStep.id],
      }));
    } else {
      usePlayerStore.getState().markDoneAndAdvance(progressKey, currentStep.id, steps.length);
    }
  }, [preview, currentStep, nextDisabled, progressKey, steps.length, setInspected]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (isTextControl(event.target) || isTextControl(document.activeElement)) return;
      if (event.key === 'ArrowRight' && !nextDisabled) {
        event.preventDefault();
        next();
      }
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault();
        back();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [back, index, next, nextDisabled]);

  function restart(): void {
    completionReported.current = false;
    if (preview) setPreviewProgress({ cur: 0, done: [], checked: [] });
    else usePlayerStore.getState().restart(progressKey);
    go(0);
  }

  function setChecked(stepId: string, checked: boolean): void {
    if (preview) {
      setPreviewProgress((progress) => ({
        ...progress,
        checked: checked ? [...new Set([...progress.checked, stepId])] : progress.checked.filter((id) => id !== stepId),
      }));
    } else {
      usePlayerStore.getState().setChecked(progressKey, stepId, checked);
    }
  }

  function openProcedure(slug: string, stepId?: string) {
    if (slug === procedure.slug) {
      const requestedIndex = steps.findIndex((step) => step.id === stepId);
      if (requestedIndex >= 0) go(requestedIndex);
    }
    onOpenProcedure(slug, stepId);
  }

  return (
    <>
      {viewport?.tools && createPortal(<>
        {machine.definition.stateVars.filter((variable) => variable.userToggle).map((variable) => (
          <label key={variable.name}>
            <input type="checkbox" checked={Boolean(state[variable.name])} onChange={(event) => setToggle(variable.name, event.target.checked)} />
            {variable.label}
          </label>
        ))}
        <button type="button" onClick={() => syncStepView()}>Back to step view</button>
      </>, viewport.tools)}
      {viewport?.inspector && inspectedPart && createPortal(
        <PartInspector part={inspectedPart} steps={steps} onGo={go} onClose={() => setInspected(null)} />,
        viewport.inspector,
      )}
      <div className="panel-head procedure-info">
        {preview && <p className="draft" role="status">Draft preview — not recorded</p>}
        <p className="procedure-meta">
          {`${steps.length} steps · about ${content.minutes} min`}
          {procedure.placeholder && <> <span className="tag tag-caution">Placeholder content</span></>}
        </p>
        <details className="procedure-about">
          <summary>About this procedure</summary>
          <p>{content.summary}</p>
          {procedure.placeholder && <p>Example content for this prototype. Swap in your lab's approved SOP before training anyone with it.</p>}
        </details>
      </div>
      {index >= steps.length ? (
        <div className="steps">
          <div className="complete">
            <h2>Procedure complete</h2>
            <p>{`All ${steps.length} steps of "${content.title}" are done.`}</p>
            <button type="button" className="btn" onClick={restart}>Start again</button>
          </div>
        </div>
      ) : (
        <StepList
          steps={steps}
          progress={progress}
          currentRowRef={currentRow}
          linkTargets={linkTargets}
          mediaUrls={mediaUrls}
          onGo={go}
          onChecked={setChecked}
          onOpenProcedure={openProcedure}
        />
      )}
      <div className="progress" role="progressbar" aria-label="Procedure progress"
        aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={index}>
        <div className="progress-fill" style={{ width: `${steps.length > 0 ? index / steps.length * 100 : 100}%` }} />
      </div>
      <PlayerFooter index={index} stepCount={steps.length} nextDisabled={nextDisabled} onBack={back} onNext={next} />
      <p className="sr" aria-live="polite">{announcement}</p>
    </>
  );
}

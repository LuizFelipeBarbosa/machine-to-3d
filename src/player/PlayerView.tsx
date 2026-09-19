import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { MachineRecord, ProcedureRecord } from '../data/catalog';
import { MachineScene } from '../scene';
import type { MachineSceneHandle } from '../scene';
import { PartInspector } from './PartInspector';
import { PlayerFooter } from './PlayerFooter';
import { StepList } from './StepList';
import { usePlayerStore } from './playerStore';
import { useEffectiveState } from './useEffectiveState';

export type PlayerViewProps = {
  machine: MachineRecord;
  procedure: ProcedureRecord;
  linkTargets: Record<string, string[]>;
  onOpenProcedure(procedureSlug: string, stepId?: string): void;
  initialStepId?: string;
};

function isTextControl(target: EventTarget | null): boolean {
  return target instanceof Element && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
}

export function PlayerView({ machine, procedure, linkTargets, onOpenProcedure, initialStepId }: PlayerViewProps): JSX.Element {
  const { content } = procedure;
  const { steps } = content;
  const progressKey = `${machine.slug}/${procedure.slug}`;
  // Select the stored entry, not get(): its fresh default is not a stable store snapshot.
  const savedProgress = usePlayerStore((store) => store.progress[progressKey]);
  const [initialIndex] = useState(() => {
    const requestedIndex = steps.findIndex((step) => step.id === initialStepId);
    const index = requestedIndex >= 0 ? requestedIndex : usePlayerStore.getState().get(progressKey).cur;
    return Math.max(0, Math.min(index, steps.length));
  });
  const [initialized, setInitialized] = useState(false);
  const index = initialized ? Math.max(0, Math.min(savedProgress?.cur ?? 0, steps.length)) : initialIndex;
  const progress = { cur: index, done: savedProgress?.done ?? [], checked: savedProgress?.checked ?? [] };
  const currentStep = steps[index];
  const sceneStep = steps[Math.min(index, steps.length - 1)];
  const { state, setToggle } = useEffectiveState(content, index);
  const [inspected, setInspected] = useState<string | null>(null);
  const inspectedPart = machine.definition.parts.find((part) => part.name === inspected);
  const highlightedParts = [...(sceneStep?.parts ?? [])];
  if (inspectedPart && !highlightedParts.includes(inspectedPart.name)) {
    highlightedParts.push(inspectedPart.name);
  }

  const scene = useRef<MachineSceneHandle>(null);
  const currentRow = useRef<HTMLLIElement>(null);
  const synchronizedStep = useRef<{ index: number; content: typeof content } | null>(null);
  const [initialView] = useState(sceneStep?.view);
  const nextDisabled = !currentStep || Boolean(currentStep.check && !progress.checked.includes(currentStep.id));
  const announcement = currentStep ? `Step ${index + 1} of ${steps.length}: ${currentStep.title}` : 'Procedure complete';

  useEffect(() => {
    usePlayerStore.getState().go(progressKey, initialIndex, steps.length);
    setInitialized(true);
  }, [progressKey, initialIndex, steps.length]);

  const syncStepView = useCallback((instant = false) => {
    if (sceneStep) scene.current?.goToView(sceneStep.view, { instant });
  }, [sceneStep]);

  useEffect(function synchronizeCurrentStep() {
    const previous = synchronizedStep.current;
    if (previous?.index === index && previous.content === content) return;
    syncStepView(previous === null);
    synchronizedStep.current = { index, content };
    setInspected(null);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    currentRow.current?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
    // Highlights and the live announcement are derived from this same index above.
  }, [content, index, syncStepView]);

  const go = useCallback((nextIndex: number) => {
    setInspected(null);
    usePlayerStore.getState().go(progressKey, nextIndex, steps.length);
  }, [progressKey, steps.length]);

  const back = useCallback(() => {
    if (index > 0) go(index - 1);
  }, [go, index]);

  const next = useCallback(() => {
    if (nextDisabled || !currentStep) return;
    setInspected(null);
    usePlayerStore.getState().markDoneAndAdvance(progressKey, currentStep.id, steps.length);
  }, [currentStep, nextDisabled, progressKey, steps.length]);

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
    usePlayerStore.getState().restart(progressKey);
    go(0);
  }

  return (
    <main className="app">
      <section className="viewport" aria-label="3D view of the instrument">
        <MachineScene
          ref={scene}
          className="app-root"
          modelUrl={machine.modelUrl}
          definition={machine.definition}
          state={state}
          highlightedParts={highlightedParts}
          initialView={initialView}
          onPickPart={setInspected}
        />
        <div className="vp-top">
          <div className="machine"><h1>{machine.name}</h1><p>{machine.kind}</p></div>
          <div className="tools">
            {machine.definition.stateVars.filter((variable) => variable.userToggle).map((variable) => (
              <label key={variable.name}>
                <input type="checkbox" checked={Boolean(state[variable.name])} onChange={(event) => setToggle(variable.name, event.target.checked)} />
                {variable.label}
              </label>
            ))}
            <button type="button" onClick={() => syncStepView()}>Back to step view</button>
          </div>
        </div>
        {inspectedPart && <PartInspector part={inspectedPart} steps={steps} onGo={go} onClose={() => setInspected(null)} />}
        <p className="hint">Drag to orbit, scroll to zoom, click a part to identify it</p>
      </section>
      <aside className="panel" aria-label="Procedure">
        <div className="panel-head">
          <label>Procedure</label>
          <h2>{content.title}</h2>
          <p className="panel-summary">{`${content.summary} ${steps.length} steps, about ${content.minutes} minutes.`}</p>
          {procedure.placeholder && <p className="draft">Example content for this prototype. Swap in your lab's approved SOP before training anyone with it.</p>}
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
            onGo={go}
            onChecked={(stepId, checked) => usePlayerStore.getState().setChecked(progressKey, stepId, checked)}
            onOpenProcedure={onOpenProcedure}
          />
        )}
        <PlayerFooter index={index} stepCount={steps.length} nextDisabled={nextDisabled} onBack={back} onNext={next} />
        <p className="sr" aria-live="polite">{announcement}</p>
      </aside>
    </main>
  );
}

import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { ProcedureContent } from '../../shared/procedure';
import type { MachineRecord } from '../data/catalog';
import { MachineScene } from '../scene';
import type { MachineSceneHandle } from '../scene';
import { stateBeforeStep, stateForStep } from './editorOps';
import { selectIssues, selectSelectedStep, useEditorStore } from './editorStore';
import { IssuesPanel } from './IssuesPanel';
import { MetaForm } from './MetaForm';
import { StepForm } from './StepForm';
import { StepListEditor } from './StepListEditor';
import { useAutosave } from './useAutosave';
import type { AutosaveControls } from './useAutosave';
import { saveStatusLabels } from './VersionBar';

export type EditorViewProps = {
  machine: MachineRecord;
  procedureSlug: string;
  initialContent: ProcedureContent;
  linkTargets: Record<string, string[]>;
  procedureTitles?: Record<string, string>;
  mediaUrls?: Record<string, string>;
  disabled?: boolean;
  onSave?: (content: ProcedureContent) => Promise<void>;
  onPreview?: (content: ProcedureContent) => void | Promise<void>;
  headerSlot?: ReactNode | ((autosave: AutosaveControls) => ReactNode);
};

export function EditorView({ machine, procedureSlug, initialContent, linkTargets, procedureTitles, mediaUrls, disabled = false, onSave, onPreview, headerSlot }: EditorViewProps): JSX.Element {
  const store = useEditorStore();
  const [initialized, setInitialized] = useState(false);
  const [scene, setScene] = useState<MachineSceneHandle | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const selected = selectSelectedStep(store);
  const selectedId = selected?.id;
  const currentLinkTargets = useMemo(() => onSave && store.content ? {
    ...linkTargets,
    [procedureSlug]: store.content.steps.map((step) => step.id),
  } : linkTargets, [linkTargets, onSave, procedureSlug, store.content]);
  const issues = selectIssues({ ...store, linkTargets: currentLinkTargets });

  useLayoutEffect(() => {
    store.load({ content: initialContent, machine: machine.definition, linkTargets: {} });
    setInitialized(true);
  }, [store.load, initialContent, machine.definition, procedureSlug]);

  useLayoutEffect(() => {
    useEditorStore.setState({ linkTargets: currentLinkTargets });
  }, [currentLinkTargets]);

  const autosave = useAutosave(onSave);
  const busy = disabled || previewing || uploading;

  useEffect(() => {
    // Read the latest view only when selection or scene readiness changes.
    // Editing a field or capturing a view must leave the author's orbit alone.
    const step = selectSelectedStep(useEditorStore.getState());
    if (step) scene?.goToView(step.view, { instant: false });
  }, [scene, selectedId]);

  function selectStep(id: string): void {
    store.select(id);
    if (selected?.id === id) scene?.goToView(selected.view, { instant: false });
  }

  async function preview(): Promise<void> {
    if (!onPreview || busy) return;
    setPreviewing(true);
    try {
      if (onSave && !await autosave.flush()) return;
      const content = useEditorStore.getState().content;
      if (content) await onPreview(content);
    } finally {
      setPreviewing(false);
    }
  }

  const content = store.content;
  if (!initialized || !content) return <p role="status">Loading editor…</p>;
  const state = selected ? stateForStep(content, selected.id) : content.start;

  return (
    <main className="app editor-app">
      <section className="viewport" aria-label="3D view of the instrument">
        <MachineScene
          ref={setScene}
          className="app-root"
          modelUrl={machine.modelUrl}
          definition={machine.definition}
          state={state}
          highlightedParts={selected?.parts ?? []}
          initialView={initialContent.steps[0]?.view}
          onPickPart={(part) => {
            if (!busy && selected && part !== null) store.togglePart(selected.id, part);
          }}
        />
        <div className="vp-top">
          <div className="machine"><h1>{machine.name}</h1><p>{machine.kind}</p></div>
          <div className="tools">
            <button type="button" disabled={!scene || !selected} onClick={() => {
              if (selected) scene?.goToView(selected.view);
            }}>Back to step view</button>
          </div>
        </div>
        <p className="editor-orbit-hint">Drag to orbit, scroll to zoom, click a part to add or remove it</p>
      </section>
      <aside className="panel editor-panel" aria-label="Procedure editor">
        <header className="panel-head">
          <h2 className="editor-heading">{content.title || 'Untitled procedure'}</h2>
          <div className="editor-toolbar">
            {onSave ? (
              <>
                <span className="editor-hint" role="status">{saveStatusLabels[autosave.status]}</span>
                <button type="button" className="btn" disabled={!store.dirty || autosave.status === 'saving' || busy}
                  onClick={() => void autosave.saveNow()}>Save now</button>
              </>
            ) : <span className="editor-hint">Local demo: changes are not saved</span>}
            {issues.length > 0 && <span className="editor-warning">{issues.length} validation {issues.length === 1 ? 'issue' : 'issues'}</span>}
            {onPreview && <button type="button" className="btn" disabled={busy} onClick={() => void preview()}>
              {previewing ? 'Preparing preview…' : 'Preview'}
            </button>}
            {!onSave && <span className="editor-hint" role="status">{store.dirty ? 'Unsaved changes' : 'No changes'}</span>}
          </div>
          {autosave.error && <p className="caution" role="alert">Unable to save draft: {autosave.error}</p>}
          {headerSlot && (
            <fieldset className="editor-content-fields" disabled={busy}>
              {typeof headerSlot === 'function' ? headerSlot(autosave) : headerSlot}
            </fieldset>
          )}
        </header>
        <div className="editor-scroll">
          <fieldset className="editor-content-fields" disabled={busy}>
            <MetaForm content={content} stateVars={machine.definition.stateVars} onPatch={store.patchMeta} onSetStartState={store.setStartState} />
            <StepListEditor
              steps={content.steps}
              selectedId={store.selectedStepId}
              canAdd={scene !== null}
              onSelect={selectStep}
              onAdd={(afterId) => {
                if (scene) store.addStep(afterId, scene.getCurrentView());
              }}
              onRemove={store.removeStep}
              onMove={store.moveStep}
            />
            {selected ? (
              <StepForm
                step={selected}
                machine={machine.definition}
                inherited={stateBeforeStep(content, selected.id)}
                linkTargets={currentLinkTargets}
                procedureTitles={procedureTitles}
                mediaUrls={mediaUrls}
                onUploadStateChange={setUploading}
                scene={scene}
                onPatch={(patch) => store.patchStep(selected.id, patch)}
                onTogglePart={(part) => store.togglePart(selected.id, part)}
                onSetState={(name, value) => store.setStepState(selected.id, name, value)}
              />
            ) : <p className="editor-hint">Add or select a step to edit it.</p>}
            <IssuesPanel issues={issues} steps={content.steps} onSelect={selectStep} />
          </fieldset>
        </div>
        <footer className="panel-foot editor-footer">{content.steps.length} steps · {procedureSlug}</footer>
      </aside>
    </main>
  );
}

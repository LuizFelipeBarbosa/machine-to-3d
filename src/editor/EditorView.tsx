import { useEffect, useLayoutEffect, useState } from 'react';
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

export type EditorViewProps = {
  machine: MachineRecord;
  procedureSlug: string;
  initialContent: ProcedureContent;
  linkTargets: Record<string, string[]>;
  procedureTitles?: Record<string, string>;
  onSave?: (content: ProcedureContent) => Promise<void>;
  onPreview?: (content: ProcedureContent) => void;
  headerSlot?: ReactNode;
};

export function EditorView({ machine, procedureSlug, initialContent, linkTargets, procedureTitles, onSave, onPreview, headerSlot }: EditorViewProps): JSX.Element {
  const store = useEditorStore();
  const [initialized, setInitialized] = useState(false);
  const [scene, setScene] = useState<MachineSceneHandle | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const selected = selectSelectedStep(store);
  const selectedId = selected?.id;
  const issues = selectIssues(store);

  useLayoutEffect(() => {
    store.load({ content: initialContent, machine: machine.definition, linkTargets });
    setInitialized(true);
    setSaveError(null);
  }, [store.load, initialContent, machine.definition, linkTargets, procedureSlug]);

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

  async function saveDraft(): Promise<void> {
    const content = store.content;
    if (!onSave || !content || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(content);
      // Edits made during the request still need to be saved.
      if (useEditorStore.getState().content === content) store.markSaved();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
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
            if (selected && part !== null) store.togglePart(selected.id, part);
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
              <button type="button" className="btn" disabled={!store.dirty || saving} onClick={() => void saveDraft()}>
                {saving ? 'Saving…' : 'Save draft'}
              </button>
            ) : <span className="editor-hint">Local demo: changes are not saved</span>}
            {issues.length > 0 && <span className="editor-warning">{issues.length} validation {issues.length === 1 ? 'issue' : 'issues'}</span>}
            {onPreview && <button type="button" className="btn" onClick={() => onPreview(content)}>Preview</button>}
            <span className="editor-hint" role="status">{store.dirty ? 'Unsaved changes' : 'No changes'}</span>
          </div>
          {saveError && <p className="caution" role="alert">Unable to save draft: {saveError}</p>}
          {headerSlot}
        </header>
        <div className="editor-scroll">
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
              linkTargets={linkTargets}
              procedureTitles={procedureTitles}
              scene={scene}
              onPatch={(patch) => store.patchStep(selected.id, patch)}
              onTogglePart={(part) => store.togglePart(selected.id, part)}
              onSetState={(name, value) => store.setStepState(selected.id, name, value)}
            />
          ) : <p className="editor-hint">Add or select a step to edit it.</p>}
          <IssuesPanel issues={issues} steps={content.steps} onSelect={selectStep} />
        </div>
        <footer className="panel-foot editor-footer">{content.steps.length} steps · {procedureSlug}</footer>
      </aside>
    </main>
  );
}

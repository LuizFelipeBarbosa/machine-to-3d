import { useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { MachineState } from '../../shared/machine';
import type { MachineRecord } from '../data/catalog';
import { MachineScene } from '../scene';
import type { MachineSceneHandle } from '../scene';

type MachineExplorerProps = {
  machine: MachineRecord;
  procedures: { slug: string; title: string; minutes?: number; hasDraft?: boolean; hasApproved?: boolean }[];
  canEdit?: boolean;
  procedureTools?: ReactNode;
};

export function MachineExplorer({ machine, procedures, canEdit = false, procedureTools }: MachineExplorerProps): JSX.Element {
  const { definition } = machine;
  const scene = useRef<MachineSceneHandle>(null);
  const [sceneKey, setSceneKey] = useState(0);
  const [inspectedPart, setInspectedPart] = useState<string | null>(null);
  const [state, setState] = useState<MachineState>(() => Object.fromEntries(
    definition.stateVars.map((variable) => {
      const visibleOnly = variable.effects.every((effect) => effect.type === 'visible');
      return [variable.name, visibleOnly];
    }),
  ));
  const selectedPart = definition.parts.find((part) => part.name === inspectedPart);

  function setToggle(name: string, checked: boolean): void {
    setState((previous) => ({ ...previous, [name]: checked }));
  }

  function resetView(): void {
    const firstView = definition.presetViews[0];
    if (firstView) {
      scene.current?.goToView(firstView.view);
    } else {
      // Remount so the scene frames the model from its bounds again.
      setSceneKey((previous) => previous + 1);
    }
  }

  return (
    <main className="app">
      <section className="viewport" aria-label="3D view of the instrument">
        <MachineScene
          key={sceneKey}
          ref={scene}
          modelUrl={machine.modelUrl}
          definition={definition}
          state={state}
          highlightedParts={inspectedPart ? [inspectedPart] : []}
          onPickPart={setInspectedPart}
        />
        <div className="vp-top">
          <div className="machine">
            <h1>{machine.name}</h1>
            <p>{machine.kind}</p>
          </div>
          <div className="tools">
            {definition.stateVars.map((variable) => (
              <label key={variable.name}>
                <input
                  type="checkbox"
                  checked={Boolean(state[variable.name])}
                  onChange={(event) => setToggle(variable.name, event.target.checked)}
                />
                {variable.label}
              </label>
            ))}
            <button type="button" onClick={resetView}>Reset view</button>
          </div>
        </div>
        {selectedPart && (
          <div className="inspect">
            <button
              type="button"
              className="close"
              aria-label="Close part details"
              onClick={() => setInspectedPart(null)}
            >
              ×
            </button>
            <h2>{selectedPart.label}</h2>
            <p>{selectedPart.blurb}</p>
          </div>
        )}
        <p className="hint">Drag to orbit, scroll to zoom, click a part to identify it</p>
      </section>
      <aside className="panel" aria-label="Explore">
        <div className="panel-head">
          <label>Explore</label>
          <h2>{machine.name}</h2>
        </div>
        <div className="steps">
          <section className="explorer-section">
            <h3>Views</h3>
            {definition.presetViews.map((preset) => (
              <button
                type="button"
                className="btn"
                key={preset.name}
                onClick={() => scene.current?.goToView(preset.view)}
              >
                {preset.label}
              </button>
            ))}
          </section>
          <section className="explorer-section">
            <h3>Parts</h3>
            <ul className="part-list">
              {definition.parts.map((part) => (
                <li key={part.name}>
                  <button
                    type="button"
                    className="part-row"
                    aria-pressed={inspectedPart === part.name}
                    onClick={() => setInspectedPart(part.name)}
                  >
                    {part.label}
                    <span className="part-blurb">{part.blurb}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="explorer-section">
            <h3>Procedures</h3>
            {procedureTools}
            {procedures.length === 0 ? (
              <p>No procedures yet</p>
            ) : (
              <ul>
                {procedures.map((procedure) => (
                  <li key={procedure.slug}>
                    {!canEdit || procedure.hasApproved ? (
                      <Link to={`/m/${encodeURIComponent(machine.slug)}/${encodeURIComponent(procedure.slug)}`}>
                        {procedure.title}
                      </Link>
                    ) : <span>{procedure.title}</span>}
                    {procedure.minutes !== undefined && <> — {procedure.minutes} min</>}
                    {canEdit && (
                      <div className="version-actions">
                        {procedure.hasDraft && <span className="status-chip draft">Draft</span>}
                        {procedure.hasApproved && <span className="status-chip">Approved</span>}
                        {!procedure.hasDraft && !procedure.hasApproved && <span className="status-chip">Unpublished</span>}
                        <Link to={`/m/${encodeURIComponent(machine.slug)}/${encodeURIComponent(procedure.slug)}/edit`}>Edit</Link>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </aside>
    </main>
  );
}

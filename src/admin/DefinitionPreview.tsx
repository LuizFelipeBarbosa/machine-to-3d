import { useEffect, useRef, useState } from 'react';
import type { MachineDefinition, MachineState } from '../../shared/machine';
import { MachineScene } from '../scene';
import type { MachineSceneHandle } from '../scene';

type DefinitionPreviewProps = {
  file: File;
  definition: MachineDefinition;
};

export function DefinitionPreview({ file, definition }: DefinitionPreviewProps) {
  const [model, setModel] = useState<{ file: File; url: string } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setModel({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);

  if (model?.file !== file) return <p role="status">Preparing preview…</p>;
  return (
    <PreviewControls
      key={`${model.url}:${JSON.stringify(definition)}`}
      modelUrl={model.url}
      definition={definition}
    />
  );
}

function PreviewControls({ modelUrl, definition }: { modelUrl: string; definition: MachineDefinition }) {
  const scene = useRef<MachineSceneHandle>(null);
  const [sceneKey, setSceneKey] = useState(0);
  const [inspectedPart, setInspectedPart] = useState<string | null>(null);
  const [state, setState] = useState<MachineState>(() => Object.fromEntries(
    definition.stateVars.map((variable) => [
      variable.name,
      variable.effects.every((effect) => effect.type === 'visible'),
    ]),
  ));
  const selectedPart = definition.parts.find((part) => part.name === inspectedPart);

  function resetView() {
    const firstView = definition.presetViews[0];
    if (firstView) scene.current?.goToView(firstView.view);
    else setSceneKey((previous) => previous + 1);
  }

  return (
    <section className="admin-preview" aria-label="Definition preview">
      <h2>Preview</h2>
      <div className="admin-toggles">
        {definition.stateVars.map((variable) => (
          <label key={variable.name}>
            <input
              type="checkbox"
              checked={Boolean(state[variable.name])}
              onChange={(event) => {
                const checked = event.target.checked;
                setState((previous) => ({ ...previous, [variable.name]: checked }));
              }}
            />
            {variable.label || variable.name}
          </label>
        ))}
        <button type="button" className="btn" onClick={resetView}>Reset view</button>
      </div>
      <MachineScene
        key={sceneKey}
        ref={scene}
        className="admin-scene"
        modelUrl={modelUrl}
        definition={definition}
        state={state}
        highlightedParts={inspectedPart ? [inspectedPart] : []}
        onPickPart={setInspectedPart}
      />
      <p className="admin-hint">Drag to orbit, scroll to zoom, click a part to identify it.</p>
      {selectedPart && (
        <div className="admin-part">
          <h3>{selectedPart.label}</h3>
          <p>{selectedPart.blurb}</p>
          <button type="button" className="btn" onClick={() => setInspectedPart(null)}>Close part details</button>
        </div>
      )}
    </section>
  );
}

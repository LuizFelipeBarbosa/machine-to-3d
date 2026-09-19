import type { JSX } from 'react';
import type { PresetView, View } from '../../shared/machine';
import type { MachineSceneHandle } from '../scene';

type ViewCaptureProps = {
  view: View;
  presets: PresetView[];
  scene: MachineSceneHandle | null;
  onCapture(view: View): void;
};

export function ViewCapture({ view, presets, scene, onCapture }: ViewCaptureProps): JSX.Element {
  return (
    <fieldset className="editor-fieldset">
      <legend>Step view</legend>
      <p className="editor-hint">Orbit to frame the instrument, then capture the view.</p>
      <div className="editor-actions">
        <button type="button" className="btn" disabled={!scene} onClick={() => {
          if (scene) onCapture(scene.getCurrentView());
        }}>
          Capture current view
        </button>
        <button type="button" className="btn" disabled={!scene} onClick={() => scene?.goToView(view)}>
          Show this view
        </button>
      </div>
      <label className="editor-field">
        Start from preset
        <select value="" disabled={!scene} onChange={(event) => {
          const preset = presets.find((entry) => entry.name === event.target.value);
          if (preset) scene?.goToView(preset.view);
        }}>
          <option value="">Choose a preset…</option>
          {presets.map((preset) => <option key={preset.name} value={preset.name}>{preset.label}</option>)}
        </select>
      </label>
      <p className="editor-hint">Presets are saved to this step only when captured.</p>
      <dl className="editor-view-values" aria-label="Saved camera coordinates">
        <dt>Position</dt>
        <dd>{view.pos.map((value) => value.toFixed(2)).join(', ')}</dd>
        <dt>Target</dt>
        <dd>{view.target.map((value) => value.toFixed(2)).join(', ')}</dd>
      </dl>
    </fieldset>
  );
}

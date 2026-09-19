import { Link } from 'react-router-dom';
import type { MachineRecord } from '../data/catalog';
import type { ProcedureSummary } from './ProcedurePicker';
import type { SceneController } from './useSceneController';

type ExplorePanelProps = {
  machine: MachineRecord;
  procedures: ProcedureSummary[];
  controller: SceneController;
  inspected: string | null;
  canEdit?: boolean;
  onInspect(part: string): void;
  onOpenProcedure(slug: string): void;
};

export function ExplorePanel({ machine, procedures, controller, inspected, canEdit, onInspect, onOpenProcedure }: ExplorePanelProps) {
  const { definition } = machine;

  return (
    <div className="steps">
      <section className="explorer-section">
        <h3>Views</h3>
        {definition.presetViews.map((preset) => (
          <button
            type="button"
            className="btn"
            key={preset.name}
            onClick={() => controller.handle.current?.goToView(preset.view)}
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
                aria-pressed={inspected === part.name}
                onClick={() => onInspect(part.name)}
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
        {procedures.length === 0 ? <p>No procedures yet</p> : (
          <ul>
            {procedures.map((procedure) => (
              <li key={procedure.slug}>
                <button
                  type="button"
                  className="btn"
                  disabled={canEdit && procedure.hasApproved === false}
                  onClick={() => onOpenProcedure(procedure.slug)}
                >
                  {procedure.title}
                  {procedure.minutes !== undefined && ` · ${procedure.minutes} min`}
                </button>
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
  );
}

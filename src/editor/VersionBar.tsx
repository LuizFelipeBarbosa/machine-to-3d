import { useState } from 'react';
import type { Id } from '../../convex/_generated/dataModel';
import { errorMessage } from '../lib/errorMessage';
import type { AutosaveStatus } from './useAutosave';

type VersionSummary = {
  _id: Id<'procedureVersions'>;
  version: number;
  status: 'draft' | 'approved' | 'retired';
  _creationTime: number;
  approvedAt?: number;
  changeNote?: string;
};

type VersionBarProps = {
  versions: VersionSummary[];
  draftId?: Id<'procedureVersions'>;
  status?: AutosaveStatus;
  canApprove?: boolean;
  onCreateDraft?(fromVersionId?: Id<'procedureVersions'>): Promise<void>;
  onDiscard?(): Promise<void>;
  onApprove?(changeNote: string): Promise<void>;
};

export const saveStatusLabels: Record<AutosaveStatus, string> = {
  saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved', error: 'Unsaved — save failed',
};

export function VersionBar({
  versions, draftId, status = 'saved', canApprove = false, onCreateDraft, onDiscard, onApprove,
}: VersionBarProps) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [approving, setApproving] = useState(false);
  const [changeNote, setChangeNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = versions.find((version) => version._id === draftId);

  async function run(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
      setConfirmDiscard(false);
      setApproving(false);
      setChangeNote('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="version-bar" aria-label="Procedure versions">
      {draft && (
        <div className="version-actions">
          <span className="status-chip draft">Draft v{draft.version}</span>
          <span role="status">{saveStatusLabels[status]}</span>
          {onDiscard && (
            <button type="button" className="btn" disabled={pending} onClick={() => {
              if (confirmDiscard) void run(onDiscard);
              else {
                setConfirmDiscard(true);
                setApproving(false);
              }
            }}>{confirmDiscard ? 'Really discard?' : 'Discard draft'}</button>
          )}
          {confirmDiscard && <button type="button" className="btn" disabled={pending}
            onClick={() => setConfirmDiscard(false)}>Keep draft</button>}
          {canApprove && onApprove && !approving && (
            <button type="button" className="btn primary" disabled={pending} onClick={() => {
              setApproving(true);
              setConfirmDiscard(false);
            }}>Approve…</button>
          )}
        </div>
      )}
      {approving && canApprove && onApprove && (
        <form className="editor-fields" onSubmit={(event) => {
          event.preventDefault();
          if (changeNote.trim()) void run(() => onApprove(changeNote.trim()));
        }}>
          <label className="editor-field">
            Change note
            <input required autoFocus value={changeNote} disabled={pending}
              onChange={(event) => setChangeNote(event.target.value)} />
          </label>
          <div className="version-actions">
            <button type="submit" className="btn primary" disabled={pending || !changeNote.trim()}>
              {pending ? 'Approving…' : 'Approve'}
            </button>
            <button type="button" className="btn" disabled={pending} onClick={() => setApproving(false)}>Cancel</button>
          </div>
        </form>
      )}
      <details open={!draftId}>
        <summary>Version history</summary>
        <ul className="version-history">
          {versions.map((version) => (
            <li key={version._id}>
              <span>v{version.version} · {version.status} · {new Date(version.approvedAt ?? version._creationTime).toLocaleDateString()}</span>
              {version.changeNote && <p>{version.changeNote}</p>}
              {!draftId && onCreateDraft && (
                <button type="button" className="btn" disabled={pending}
                  title="New draft from this version"
                  onClick={() => void run(() => onCreateDraft(version._id))}>
                  New draft from v{version.version}
                </button>
              )}
            </li>
          ))}
        </ul>
        {versions.length === 0 && onCreateDraft && (
          <button type="button" className="btn primary" disabled={pending}
            onClick={() => void run(() => onCreateDraft())}>Start a draft</button>
        )}
      </details>
      {error && <p className="notice error" role="alert">{error}</p>}
    </section>
  );
}

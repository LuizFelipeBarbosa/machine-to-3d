import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation } from 'convex/react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { errorMessage } from '../lib/errorMessage';

export type ProcedureSummary = {
  slug: string;
  title: string;
  minutes?: number;
  hasDraft?: boolean;
  hasApproved?: boolean;
};

type ProcedurePickerProps = {
  machineSlug: string;
  authorMachineId?: Id<'machines'>;
  procedures: ProcedureSummary[];
  selected?: string;
  onSelect(slug: string): void;
};

function NewProcedureForm({ machineId, machineSlug, onCancel }: {
  machineId: Id<'machines'>;
  machineSlug: string;
  onCancel(): void;
}) {
  const create = useMutation(api.procedures.create);
  const navigate = useNavigate();
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await create({ machineId, slug, title: title.trim() });
      await navigate(`/m/${encodeURIComponent(machineSlug)}/${encodeURIComponent(slug)}/edit`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="editor-fields new-procedure" onSubmit={(event) => void submit(event)}>
      <label className="editor-field">Slug
        <input required pattern="[a-z0-9-]+" title="Use lowercase letters, numbers, and hyphens"
          value={slug} disabled={pending} onChange={(event) => setSlug(event.target.value)} />
      </label>
      <label className="editor-field">Title
        <input required value={title} disabled={pending} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <div className="version-actions">
        <button type="submit" className="btn primary" disabled={pending || !title.trim()}>
          {pending ? 'Creating…' : 'Create procedure'}
        </button>
        <button type="button" className="btn" disabled={pending} onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
    </form>
  );
}

export function ProcedurePicker({ machineSlug, authorMachineId, procedures, selected, onSelect }: ProcedurePickerProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const machinePath = `/m/${encodeURIComponent(machineSlug)}`;
  const formOpen = !selected && searchParams.get('new') === '1';

  function setFormOpen(open: boolean) {
    const params = new URLSearchParams(searchParams);
    if (open) params.set('new', '1');
    else params.delete('new');
    void setSearchParams(params);
  }

  return (
    <>
      <div className="panel-head procedure-picker">
        <select aria-label="Procedure" value={selected ?? ''} onChange={(event) => onSelect(event.target.value)}>
          <option value="">Explore the machine</option>
          {selected && !procedures.some((procedure) => procedure.slug === selected) && (
            <option value={selected}>{selected}</option>
          )}
          {procedures.map((procedure) => (
            <option key={procedure.slug} value={procedure.slug}>
              {procedure.title}{procedure.minutes !== undefined && ` · ${procedure.minutes} min`}
            </option>
          ))}
        </select>
        {(selected || authorMachineId) && (
          <div className="picker-actions">
            {selected && <button type="button" onClick={() => onSelect('')}>Explore the machine</button>}
            {authorMachineId && <>
              {selected && <>
                <span aria-hidden="true">·</span>
                <Link to={`${machinePath}/${encodeURIComponent(selected)}/edit`}>Edit procedure</Link>
                <span aria-hidden="true">·</span>
              </>}
              {selected ? (
                <Link to={`${machinePath}?new=1`}>New procedure</Link>
              ) : (
                <button type="button" onClick={() => setFormOpen(true)}>New procedure</button>
              )}
            </>}
          </div>
        )}
      </div>
      {authorMachineId && formOpen && (
        <NewProcedureForm machineId={authorMachineId} machineSlug={machineSlug} onCancel={() => setFormOpen(false)} />
      )}
    </>
  );
}

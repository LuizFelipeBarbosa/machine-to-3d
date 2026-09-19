import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation } from 'convex/react';
import { Link, useNavigate } from 'react-router-dom';
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

function NewProcedureForm({ machineId, machineSlug }: { machineId: Id<'machines'>; machineSlug: string }) {
  const create = useMutation(api.procedures.create);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
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

  if (!open) return <button type="button" className="btn" onClick={() => setOpen(true)}>New procedure</button>;
  return (
    <form className="editor-fields" onSubmit={(event) => void submit(event)}>
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
        <button type="button" className="btn" disabled={pending} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
    </form>
  );
}

export function ProcedurePicker({ machineSlug, authorMachineId, procedures, selected, onSelect }: ProcedurePickerProps) {
  const id = useId();

  return (
    <div className="panel-head procedure-picker">
      <label htmlFor={id}>Procedure</label>
      <select id={id} value={selected ?? ''} onChange={(event) => onSelect(event.target.value)}>
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
      {selected && <button type="button" className="btn" onClick={() => onSelect('')}>Back to the machine</button>}
      {authorMachineId && (
        <div className="version-actions">
          {selected && <Link to={`/m/${encodeURIComponent(machineSlug)}/${encodeURIComponent(selected)}/edit`}>Edit</Link>}
          <NewProcedureForm machineId={authorMachineId} machineSlug={machineSlug} />
        </div>
      )}
    </div>
  );
}

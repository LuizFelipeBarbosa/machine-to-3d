import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { ROLE_RANK } from '../auth/roles';
import { useMe } from '../auth/useMe';
import { useCatalog } from '../data/CatalogContext';
import { isConvexMode } from '../data/mode';
import { MachineExplorer } from '../explorer/MachineExplorer';
import { errorMessage } from '../lib/errorMessage';
import { useAsync } from '../lib/useAsync';

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

function AuthorMachine() {
  const { machine } = useParams<{ machine: string }>();
  const record = useQuery(api.machines.getBySlug, machine ? { slug: machine } : 'skip');
  const procedures = useQuery(api.procedures.listForMachine, record ? { machineId: record._id } : 'skip');
  if (record === undefined) return <p className="notice" role="status">Loading machine…</p>;
  if (record === null) return <p className="notice">Machine not found</p>;
  if (!record.version.modelUrl) return <p className="notice" role="alert">The machine model is unavailable.</p>;
  if (procedures === undefined) return <p className="notice" role="status">Loading procedures…</p>;
  return (
    <MachineExplorer
      key={record._id}
      machine={{
        slug: record.slug, name: record.name, kind: record.kind,
        modelUrl: record.version.modelUrl, definition: record.version.definition,
      }}
      procedures={procedures}
      canEdit
      procedureTools={<NewProcedureForm machineId={record._id} machineSlug={record.slug} />}
    />
  );
}

function ConvexMachine() {
  const { me, loading } = useMe();
  if (loading) return <p className="notice" role="status">Loading account…</p>;
  return me && ROLE_RANK[me.role] >= ROLE_RANK.author ? <AuthorMachine /> : <CatalogMachine />;
}

function CatalogMachine() {
  const { machine } = useParams<{ machine: string }>();
  const catalog = useCatalog();
  const { data, error, loading } = useAsync(async () => {
    if (!machine) return null;

    const [machineRecord, machines] = await Promise.all([
      catalog.getMachine(machine),
      catalog.listMachines(),
    ]);
    if (!machineRecord) return null;

    const procedures = machines.find((summary) => summary.slug === machineRecord.slug)?.procedures ?? [];
    return { machine: machineRecord, procedures };
  }, [catalog, machine]);

  if (!loading && !error && data) {
    return (
      <MachineExplorer
        key={data.machine.slug}
        machine={data.machine}
        procedures={data.procedures}
      />
    );
  }

  return (
    <main className="panel">
      <header className="panel-head">
        <Link to="/">All machines</Link>
        {loading && <p role="status">Loading machine…</p>}
        {error && <p role="alert">Unable to load machine: {error.message}</p>}
        {!loading && !error && !data && <p>Not found</p>}
      </header>
    </main>
  );
}

export function Machine() {
  return isConvexMode ? <ConvexMachine /> : <CatalogMachine />;
}

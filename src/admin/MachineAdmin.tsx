import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { Link } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { GlbSummary } from '../../scripts/lib/glb';
import { MachineDefinitionSchema } from '../../shared/machine';
import type { MachineDefinition } from '../../shared/machine';
import { RequireRole } from '../auth/RequireRole';
import { isConvexMode } from '../data/mode';
import { errorMessage } from '../lib/errorMessage';
import { DefinitionPreview } from './DefinitionPreview';
import { useGlbCheck } from './useGlbCheck';

type MachineSummary = FunctionReturnType<typeof api.machines.list>[number];

export function MachineAdmin() {
  if (!isConvexMode) return <p className="notice">Needs the backend</p>;
  return <RequireRole minimum="admin"><MachineAdminForm /></RequireRole>;
}

function parseDefinition(text: string): { definition: MachineDefinition | null; issues: string[] } {
  if (!text.trim()) return { definition: null, issues: ['Paste a machine.json definition.'] };
  try {
    const result = MachineDefinitionSchema.safeParse(JSON.parse(text));
    if (!result.success) {
      return {
        definition: null,
        issues: result.error.issues.map((issue) => `${issue.path.join('.') || 'definition'}: ${issue.message}`),
      };
    }
    return { definition: result.data, issues: [] };
  } catch (cause) {
    return { definition: null, issues: [`JSON: ${errorMessage(cause)}`] };
  }
}

function MachineAdminForm() {
  const machines = useQuery(api.machines.list, {});
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const publishVersion = useMutation(api.machines.publishVersion);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [json, setJson] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<{ slug: string; version: number } | null>(null);
  const selected = machines?.find((machine) => machine.slug === slug);
  const parsed = useMemo(() => parseDefinition(json), [json]);
  const { definition } = parsed;
  const { summary, issues: glbIssues } = useGlbCheck(file, definition);
  const issues = [...parsed.issues, ...glbIssues];
  if (!/^[a-z0-9-]+$/.test(slug)) issues.push('Slug must contain only lowercase letters, numbers, and hyphens.');
  if (!name.trim()) issues.push('Name is required.');
  if (!kind.trim()) issues.push('Kind is required.');
  const canPublish = issues.length === 0 && summary !== null && definition !== null && file !== null;

  function selectMachine(machine: MachineSummary) {
    setSlug(machine.slug);
    setName(machine.name);
    setKind(machine.kind);
    setPublished(null);
    setError(null);
  }

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (publishing || !canPublish || !file || !definition) return;
    setPublishing(true);
    setError(null);
    setPublished(null);
    try {
      const url = await generateUploadUrl({ kind: 'model' });
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'model/gltf-binary' },
        body: file,
      });
      if (!response.ok) throw new Error('The GLB could not be uploaded. Please try again.');
      const uploaded: unknown = await response.json();
      if (!uploaded || typeof uploaded !== 'object' || !('storageId' in uploaded)
        || typeof uploaded.storageId !== 'string' || !uploaded.storageId) {
        throw new Error('The upload did not return a file id.');
      }
      const result = await publishVersion({
        slug,
        name: name.trim(),
        kind: kind.trim(),
        modelFileId: uploaded.storageId as Id<'_storage'>,
        definition,
      });
      setPublished({ slug, version: result.version });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <main className="admin-page">
      <h1>Machines admin</h1>
      <p>Validate a GLB and its machine definition, then publish a new version.</p>
      <div className="admin-layout">
        <section className="admin-existing" aria-label="Existing machines">
          <h2>Existing machines</h2>
          <p className="admin-hint">Select a machine to publish its next version.</p>
          {machines === undefined ? <p role="status">Loading machines…</p> : (
            <ul className="admin-machine-list">
              {machines.map((machine) => (
                <ExistingMachine
                  key={machine._id}
                  machine={machine}
                  selected={slug === machine.slug}
                  disabled={publishing}
                  onSelect={() => selectMachine(machine)}
                />
              ))}
            </ul>
          )}
          {machines?.length === 0 && <p>No machines yet.</p>}
          {selected && <MachineVersions key={selected._id} machineId={selected._id} />}
        </section>
        <div className="admin-workspace">
          <form onSubmit={(event) => { void publish(event); }}>
            <fieldset className="admin-fields" disabled={publishing}>
              <legend>Publish a machine version</legend>
              <label className="admin-field">
                Slug
                <input required pattern="[a-z0-9-]+" value={slug} onChange={(event) => setSlug(event.target.value)} />
              </label>
              <label className="admin-field">
                Name
                <input required value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="admin-field">
                Kind
                <input required value={kind} onChange={(event) => setKind(event.target.value)} />
              </label>
              <label className="admin-field">
                GLB file
                <input type="file" accept=".glb,model/gltf-binary" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              </label>
              <label className="admin-field">
                machine.json
                <textarea rows={12} spellCheck={false} value={json} onChange={(event) => setJson(event.target.value)} placeholder="Paste machine.json here" />
              </label>
              {summary && <GlbDetails summary={summary} />}
              <section className="admin-validation" aria-label="Validation results" aria-live="polite">
                <h2>Validation</h2>
                {issues.length > 0 ? (
                  <ul>{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
                ) : <p>All checks passed. Ready to publish.</p>}
              </section>
              <button className="btn primary" type="submit" disabled={!canPublish || publishing}>
                {publishing ? 'Publishing…' : 'Publish version'}
              </button>
            </fieldset>
          </form>
          {error && <p className="notice error" role="alert">{error}</p>}
          {published && (
            <p className="notice" role="status">
              Published version {published.version}. <Link to={`/m/${encodeURIComponent(published.slug)}`}>View machine</Link>
            </p>
          )}
          {file && definition && summary && glbIssues.length === 0 && (
            <DefinitionPreview file={file} definition={definition} />
          )}
        </div>
      </div>
    </main>
  );
}

function ExistingMachine({ machine, selected, disabled, onSelect }: {
  machine: MachineSummary;
  selected: boolean;
  disabled: boolean;
  onSelect(): void;
}) {
  const versions = useQuery(api.machines.listVersions, { machineId: machine._id });
  const currentVersion = versions?.find((version) => version._id === machine.currentVersionId);
  let versionLabel = 'No current version';
  if (machine.currentVersionId) {
    versionLabel = versions === undefined ? 'Loading version…' : `Current version: ${currentVersion?.version ?? 'unavailable'}`;
  }
  return (
    <li>
      <button type="button" className="admin-machine" aria-pressed={selected} disabled={disabled} onClick={onSelect}>
        <strong>{machine.name}</strong>
        <span>{machine.slug} · {machine.kind}</span>
        <span>{versionLabel}</span>
      </button>
    </li>
  );
}

function MachineVersions({ machineId }: { machineId: Id<'machines'> }) {
  const versions = useQuery(api.machines.listVersions, { machineId });
  const publishDraftVersion = useMutation(api.machines.publishDraftVersion);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function publish(machineVersionId: Id<'machineVersions'>) {
    if (publishing) return;
    setPublishing(true);
    setError(null);
    try {
      await publishDraftVersion({ machineVersionId });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <section className="admin-versions" aria-label="Machine versions">
      <h2>Machine versions</h2>
      {versions === undefined ? <p role="status">Loading versions…</p> : (
        <ul>
          {versions.map((version) => (
            <li key={version._id}>
              <span>v{version.version} · {version.status === 'published' ? 'Published' : 'Draft'} · {new Date(version._creationTime).toLocaleDateString()}</span>
              {version.status === 'draft' && (
                <button type="button" className="btn" disabled={publishing} onClick={() => { void publish(version._id); }}>
                  Publish
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {versions?.length === 0 && <p>No versions yet.</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
    </section>
  );
}

function GlbDetails({ summary }: { summary: GlbSummary }) {
  const bounds = summary.boundingBox;
  const size = bounds ? bounds.max.map((maximum, axis) => (maximum - bounds.min[axis]).toFixed(3)).join(' × ') : 'Unavailable';
  return (
    <section className="admin-glb" aria-label="GLB summary">
      <h2>GLB summary</h2>
      <p>Roots ({summary.rootNodes.length}): {summary.rootNodes.map((node) => node || '(unnamed)').join(', ') || 'None'}</p>
      <p>{summary.nodeCount} nodes · {summary.namedNodes.length} named nodes · {summary.meshCount} meshes · {summary.animationCount} animations</p>
      <details open>
        <summary>Animations</summary>
        <ul className="admin-node-list">
          {summary.animations?.map((animation, index) => <li key={index}><code>{animation.name} ({animation.duration}s → {animation.targetNodes.join(', ')})</code></li>)}
        </ul>
      </details>
      <p>Bounding-box size (X × Y × Z): {size}</p>
      <details open>
        <summary>Named nodes</summary>
        <ul className="admin-node-list">
          {summary.namedNodes.map((node, index) => <li key={index}><code>{node}</code></li>)}
        </ul>
      </details>
    </section>
  );
}

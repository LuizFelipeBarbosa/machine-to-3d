import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { ROLE_RANK } from '../auth/roles';
import { useMe } from '../auth/useMe';
import { errorMessage } from '../lib/errorMessage';

export function NewJob() {
  const { me, loading } = useMe();
  const canAuthor = Boolean(me && ROLE_RANK[me.role] >= ROLE_RANK.author);
  const machines = useQuery(api.machines.list, canAuthor ? {} : 'skip');
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const create = useMutation(api.draftJobs.create);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [machineChoice, setMachineChoice] = useState<string | null>(null);
  const machineId = machineChoice ?? machines?.find((machine) => machine.slug === searchParams.get('machine'))?._id ?? '';
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const [title, setTitle] = useState('');
  const [editedProcedureSlug, setEditedProcedureSlug] = useState<string | null>(null);
  const procedureSlug = editedProcedureSlug ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const [brief, setBrief] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = status !== null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canAuthor || !file || !machineId) return;
    setStatus('Uploading video…');
    setError(null);
    try {
      const url = await generateUploadUrl({ kind: 'media' });
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!response.ok) throw new Error('The video could not be uploaded. Please try again.');
      const uploaded: unknown = await response.json();
      if (!uploaded || typeof uploaded !== 'object' || !('storageId' in uploaded)
        || typeof uploaded.storageId !== 'string' || !uploaded.storageId) {
        throw new Error('The upload did not return a file id.');
      }
      setStatus('Creating job…');
      const jobId = await create({
        ...(machineId === 'new' ? { newMachine: { slug, name: name.trim(), kind: kind.trim() } } : { machineId: machineId as Id<'machines'> }),
        procedureSlug,
        title: title.trim(),
        brief,
        videoFileId: uploaded.storageId as Id<'_storage'>,
      });
      navigate(`/jobs/${jobId}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStatus(null);
    }
  }

  return (
    <main className="panel data-page">
      <header className="panel-head"><h1>Draft from video</h1></header>
      {loading ? <p className="notice" role="status">Loading…</p> : !canAuthor ? (
        <p className="notice">Authors can draft procedures from video.</p>
      ) : (
        <>
          {machines === undefined && <p className="notice" role="status">Loading machines…</p>}
          <form onSubmit={(event) => { void submit(event); }}>
            <fieldset className="admin-fields" disabled={busy}>
              <legend>Procedure from video</legend>
              <label className="editor-field">
                Machine
                <select required value={machineId} onChange={(event) => setMachineChoice(event.target.value)}>
                  <option value="">Choose a machine…</option>
                  {machines?.map((machine) => (
                    <option key={machine._id} value={machine._id}>{machine.name} ({machine.slug})</option>
                  ))}
                  <option value="new">New machine…</option>
                </select>
              </label>
              {machineId === 'new' && (
                <>
                  <label className="editor-field">
                    Slug
                    <input required pattern="[a-z0-9-]+" value={slug} onChange={(event) => setSlug(event.target.value)} />
                  </label>
                  <label className="editor-field">
                    Name
                    <input required value={name} onChange={(event) => setName(event.target.value)} />
                  </label>
                  <label className="editor-field">
                    Kind
                    <input required value={kind} onChange={(event) => setKind(event.target.value)} />
                  </label>
                </>
              )}
              <label className="editor-field">
                Action title
                <input required value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <label className="editor-field">
                Procedure slug
                <input required pattern="[a-z0-9-]+" value={procedureSlug} onChange={(event) => setEditedProcedureSlug(event.target.value)} />
              </label>
              <label className="editor-field">
                Brief
                <textarea rows={5} value={brief} onChange={(event) => setBrief(event.target.value)}
                  placeholder="What the video shows, what the narrator skips, anything the agent should know" />
              </label>
              <label className="editor-field">
                Video
                <input required type="file" accept="video/*" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              </label>
              <button className="btn primary" type="submit" disabled={busy}>Draft from video</button>
            </fieldset>
          </form>
          <p className={status ? 'notice' : 'sr'} role="status">{status}</p>
          {error && <p className="notice error" role="alert">{error}</p>}
        </>
      )}
    </main>
  );
}

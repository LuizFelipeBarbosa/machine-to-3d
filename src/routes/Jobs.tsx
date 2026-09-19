import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { ROLE_RANK } from '../auth/roles';
import { useMe } from '../auth/useMe';
import { errorMessage } from '../lib/errorMessage';

const stages = ['workspace', 'extract', 'codex', 'verify', 'frame', 'upload', 'done'];

export function Jobs() {
  const { me, loading } = useMe();
  const canAuthor = Boolean(me && ROLE_RANK[me.role] >= ROLE_RANK.author);
  const canApprove = Boolean(me && ROLE_RANK[me.role] >= ROLE_RANK.approver);
  const all = useQuery(api.draftJobs.list, canApprove ? {} : 'skip');
  const mine = useQuery(api.draftJobs.listMine, canAuthor && !canApprove ? {} : 'skip');
  const jobs = canApprove ? all : mine;

  return (
    <main className="panel data-page">
      <header className="panel-head">
        <h1>{canApprove ? 'Jobs' : 'My jobs'}</h1>
        {canAuthor && <Link to="/jobs/new">Draft from video</Link>}
      </header>
      {(loading || (canAuthor && jobs === undefined)) && <p className="notice" role="status">Loading jobs…</p>}
      {!loading && !canAuthor && <p className="notice" role="alert">Not authorized</p>}
      {jobs?.length === 0 && <p className="notice">No jobs yet.</p>}
      {canAuthor && jobs && jobs.length > 0 && (
        <div className="table-scroll">
          <table className="data-table jobs-table">
            <caption className="sr">Procedure drafting jobs</caption>
            <thead><tr>
              <th scope="col">Title</th><th scope="col">Machine</th><th scope="col">Procedure</th>
              <th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Updated</th>
              <th scope="col"><span className="sr">Actions</span></th>
            </tr></thead>
            <tbody>{jobs.map((job) => (
              <tr key={job._id}>
                <td>{job.title}</td><td>{job.machineSlug}</td><td>{job.procedureSlug}</td><td>{job.kind}</td>
                <td>{job.status}{job.status === 'running' && ` (${job.stage})`}</td>
                <td>{new Date(job.updatedAt).toLocaleString()}</td>
                <td><Link to={`/jobs/${job._id}`}>Open</Link></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </main>
  );
}

export function JobDetail() {
  const { id } = useParams();
  const jobId = id as Id<'draftJobs'> | undefined;
  const { me, loading } = useMe();
  const canAuthor = Boolean(me && ROLE_RANK[me.role] >= ROLE_RANK.author);
  const job = useQuery(api.draftJobs.get, canAuthor && jobId ? { jobId } : 'skip');
  const events = useQuery(api.draftJobs.events, canAuthor && jobId && job ? { jobId } : 'skip');
  const cancel = useMutation(api.draftJobs.cancel);
  const retry = useMutation(api.draftJobs.retry);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runAction(action: 'cancel' | 'retry') {
    if (!jobId || pending) return;
    setPending(true);
    setError(null);
    try {
      await (action === 'cancel' ? cancel : retry)({ jobId });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  const currentStage = job ? stages.indexOf(job.stage) : -1;
  return (
    <main className="panel data-page">
      <header className="panel-head">
        <h1>{job?.title ?? 'Job'}</h1>
        {job && <p>{job.machineSlug} · {job.procedureSlug} · {job.kind}</p>}
      </header>
      {loading ? <p className="notice" role="status">Loading job…</p> : !canAuthor ? (
        <p className="notice" role="alert">Not authorized</p>
      ) : !jobId || job === null ? (
        <p className="notice">Job not found.</p>
      ) : job === undefined ? (
        <p className="notice" role="status">Loading job…</p>
      ) : (
        <>
          <ol className="job-stages" aria-label="Job stages">
            {stages.map((stage, index) => (
              <li key={stage} aria-current={index === currentStage ? 'step' : undefined}
                className={index < currentStage ? 'is-done' : index === currentStage
                  ? `is-current${job.status === 'failed' ? ' is-failed' : ''}` : undefined}>
                {stage}
              </li>
            ))}
          </ol>
          <p className="notice" role="status">Status: {job.status}</p>
          {job.status === 'failed' && <pre className="job-error">{job.lastError}</pre>}
          {job.modelChanged !== undefined && <p className="notice">Model: {job.modelChanged ? 'new draft version' : 'unchanged'}</p>}
          <div className="job-actions">
            {(job.status === 'queued' || job.status === 'running') && (
              <button className="btn" type="button" disabled={pending} onClick={() => { void runAction('cancel'); }}>Cancel</button>
            )}
            {job.status === 'failed' && (
              <button className="btn" type="button" disabled={pending} onClick={() => { void runAction('retry'); }}>Retry</button>
            )}
            {job.producedProcedureVersionId && (
              <Link to={`/m/${encodeURIComponent(job.machineSlug)}/${encodeURIComponent(job.procedureSlug)}/edit`}>Open in editor</Link>
            )}
          </div>
          {error && <p className="notice error" role="alert">{error}</p>}
          {events === undefined && <p className="notice" role="status">Loading events…</p>}
          <ol className="job-events" aria-label="Job events" aria-live="polite" aria-relevant="additions text">
            {events?.toSorted((a, b) => a.at - b.at).map((event, index) => (
              <li key={`${event.at}-${index}`} className={event.level}>
                <time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleTimeString()}</time>
                {' '}{event.level}: {event.message}
              </li>
            ))}
          </ol>
        </>
      )}
    </main>
  );
}

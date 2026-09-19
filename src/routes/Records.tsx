import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { ROLE_RANK } from '../auth/roles';
import { useMe } from '../auth/useMe';
import { errorMessage } from '../lib/errorMessage';

type RecordSummary = FunctionReturnType<typeof api.training.listMine>[number];
type TeamRecord = FunctionReturnType<typeof api.training.listAll>[number];

function RecordRow({ record, viewerId, canSignOff }: {
  record: RecordSummary | TeamRecord;
  viewerId: Id<'users'>;
  canSignOff: boolean;
}) {
  const signOff = useMutation(api.training.signOff);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownRecord = !('userId' in record) || record.userId === viewerId;

  async function sign() {
    setPending(true);
    setError(null);
    try {
      await signOff({ recordId: record._id });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <tr>
      <td>{'userId' in record ? record.userName ?? record.userEmail ?? 'Unknown user' : 'You'}</td>
      <td>{record.machineName}</td>
      <td>{record.procedureTitle} · v{record.version}</td>
      <td>
        {new Date(record.completedAt).toLocaleString()}
        <small>Self-declared · {record.checkpointCount} checkpoints</small>
      </td>
      <td>
        {record.signedOffAt !== undefined ? (
          <>{record.signedOffByName ?? 'Reviewer'}<small>{new Date(record.signedOffAt).toLocaleString()}</small></>
        ) : (
          <>
            <span>Not signed off</span>
            {canSignOff && (
              <button className="btn" type="button" disabled={pending || ownRecord}
                title={ownRecord ? 'You cannot sign off your own record' : undefined}
                onClick={() => { void sign(); }}>{pending ? 'Signing…' : 'Sign off'}</button>
            )}
          </>
        )}
        {error && <p className="notice error" role="alert">{error}</p>}
      </td>
    </tr>
  );
}

export function Records() {
  const { me, loading } = useMe();
  const canSignOff = Boolean(me && ROLE_RANK[me.role] >= ROLE_RANK.approver);
  const all = useQuery(api.training.listAll, me && canSignOff ? {} : 'skip');
  const mine = useQuery(api.training.listMine, me && !canSignOff ? {} : 'skip');
  const records = canSignOff ? all : mine;

  return (
    <main className="panel data-page">
      <header className="panel-head"><h1>{canSignOff ? 'Training records' : 'My training records'}</h1></header>
      {(loading || (me && records === undefined)) && <p className="notice" role="status">Loading records…</p>}
      {!loading && !me && <p className="notice" role="alert">Not authorized</p>}
      {records?.length === 0 && <p className="notice">No training records yet.</p>}
      {me && records && records.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="sr">Training completion and sign-off records</caption>
            <thead><tr>
              <th scope="col">Person</th><th scope="col">Machine</th><th scope="col">Procedure</th>
              <th scope="col">Completed (self-declared)</th><th scope="col">Signed off by</th>
            </tr></thead>
            <tbody>{records.map((record) => (
              <RecordRow key={record._id} record={record} viewerId={me._id} canSignOff={canSignOff} />
            ))}</tbody>
          </table>
        </div>
      )}
    </main>
  );
}

import { Link } from 'react-router-dom';
import { ROLE_RANK } from '../auth/roles';
import { useMe } from '../auth/useMe';
import { useCatalog } from '../data/CatalogContext';
import { isConvexMode } from '../data/mode';
import { useAsync } from '../lib/useAsync';

function NewMachineFromVideoLink() {
  const { me } = useMe();
  if (!me || ROLE_RANK[me.role] < ROLE_RANK.author) return null;
  return <Link className="btn" to="/jobs/new">New machine from video</Link>;
}

export function MachineList() {
  const catalog = useCatalog();
  const { data: machines, error, loading } = useAsync(() => catalog.listMachines(), [catalog]);

  return (
    <main className="panel data-page">
      <header className="panel-head">
        <h1>Bench guide</h1>
        {isConvexMode && <NewMachineFromVideoLink />}
      </header>
      {loading && <p className="notice" role="status">Loading machines…</p>}
      {error && <p className="notice error" role="alert">Unable to load machines: {error.message}</p>}
      {machines?.length === 0 && <p className="notice">No machines yet</p>}
      <div className="machine-grid">
        {machines?.map((machine) => (
          <section className="machine-card" key={machine.slug}>
            <h2><Link to={`/m/${encodeURIComponent(machine.slug)}`}>{machine.name}</Link></h2>
            <p>{machine.kind}</p>
            {machine.procedures.length === 0 ? (
              <p>No procedures yet</p>
            ) : (
              <ul>
                {machine.procedures.map((procedure) => (
                  <li key={procedure.slug}>
                    <Link to={`/m/${encodeURIComponent(machine.slug)}/${encodeURIComponent(procedure.slug)}`}>
                      {procedure.title}
                    </Link>
                    {' — '}{procedure.minutes} min
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}

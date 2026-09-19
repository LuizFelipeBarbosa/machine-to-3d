import { Link } from 'react-router-dom';
import { useCatalog } from '../data/CatalogContext';
import { useAsync } from '../lib/useAsync';

export function MachineList() {
  const catalog = useCatalog();
  const { data: machines, error, loading } = useAsync(() => catalog.listMachines(), [catalog]);

  return (
    <main className="panel">
      <header className="panel-head">
        <h1>Bench guide</h1>
      </header>
      <div className="panel-head">
        {loading && <p role="status">Loading machines…</p>}
        {error && <p role="alert">Unable to load machines: {error.message}</p>}
        {machines?.length === 0 && <p>No machines yet</p>}
        {machines?.map((machine) => (
          <section key={machine.slug}>
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

import { Link, useParams } from 'react-router-dom';
import { useCatalog } from '../data/CatalogContext';
import { useAsync } from '../lib/useAsync';

export function PlayerRoute() {
  const { machine, procedure } = useParams<{ machine: string; procedure: string }>();
  const catalog = useCatalog();
  const { data, error, loading } = useAsync(async () => {
    if (!machine || !procedure) return null;

    const [machineRecord, procedureRecord] = await Promise.all([
      catalog.getMachine(machine),
      catalog.getProcedure(machine, procedure),
    ]);
    if (!machineRecord || !procedureRecord) return null;

    return { machine: machineRecord, procedure: procedureRecord };
  }, [catalog, machine, procedure]);

  return (
    <main className="panel">
      <header className="panel-head">
        <Link to="/">All machines</Link>
        {loading && <p role="status">Loading procedure…</p>}
        {error && <p role="alert">Unable to load procedure: {error.message}</p>}
        {!loading && !error && !data && <p>Machine or procedure not found.</p>}
        {data && (
          <>
            <h1>{data.machine.name}</h1>
            <h2>{data.procedure.content.title}</h2>
          </>
        )}
      </header>
    </main>
  );
}

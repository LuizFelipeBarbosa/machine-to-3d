import { Link, useParams } from 'react-router-dom';
import { useCatalog } from '../data/CatalogContext';
import { MachineExplorer } from '../explorer/MachineExplorer';
import { useAsync } from '../lib/useAsync';

export function Machine() {
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

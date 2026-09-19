import { Link, useParams } from 'react-router-dom';
import { useCatalog } from '../data/CatalogContext';
import { EditorView } from '../editor/EditorView';
import { useAsync } from '../lib/useAsync';

export function Editor() {
  const { machine, procedure } = useParams<{ machine: string; procedure: string }>();
  const catalog = useCatalog();
  const { data, error, loading } = useAsync(async () => {
    if (!machine || !procedure) return null;

    const [machineRecord, procedureRecord, linkTargets, machines] = await Promise.all([
      catalog.getMachine(machine),
      catalog.getProcedure(machine, procedure),
      catalog.listStepIds(machine),
      catalog.listMachines(),
    ]);
    if (!machineRecord || !procedureRecord) return null;

    const procedures = machines.find((summary) => summary.slug === machineRecord.slug)?.procedures ?? [];
    const procedureTitles = Object.fromEntries(procedures.map((entry) => [entry.slug, entry.title]));
    return { machine: machineRecord, procedure: procedureRecord, linkTargets, procedureTitles };
  }, [catalog, machine, procedure]);

  if (!loading && !error && data) {
    return (
      <EditorView
        key={`${data.machine.slug}/${data.procedure.slug}`}
        machine={data.machine}
        procedureSlug={data.procedure.slug}
        initialContent={data.procedure.content}
        linkTargets={data.linkTargets}
        procedureTitles={data.procedureTitles}
        onSave={undefined}
      />
    );
  }

  return (
    <main className="panel">
      <header className="panel-head">
        <Link to="/">All machines</Link>
        {loading && <p role="status">Loading editor…</p>}
        {error && <p role="alert">Unable to load editor: {error.message}</p>}
        {!loading && !error && !data && <p>Not found</p>}
      </header>
    </main>
  );
}

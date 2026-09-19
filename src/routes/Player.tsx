import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useCatalog } from '../data/CatalogContext';
import { useAsync } from '../lib/useAsync';
import { PlayerView } from '../player/PlayerView';

export function PlayerRoute() {
  const { machine, procedure } = useParams<{ machine: string; procedure: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const { data, error, loading } = useAsync(async () => {
    if (!machine || !procedure) return null;

    const [machineRecord, procedureRecord, linkTargets] = await Promise.all([
      catalog.getMachine(machine),
      catalog.getProcedure(machine, procedure),
      catalog.listStepIds(machine),
    ]);
    if (!machineRecord || !procedureRecord) return null;

    return { machine: machineRecord, procedure: procedureRecord, linkTargets };
  }, [catalog, machine, procedure]);

  const initialStepId = searchParams.get('step') ?? undefined;
  if (!loading && !error && data) {
    return (
      <PlayerView
        key={`${data.machine.slug}/${data.procedure.slug}/${initialStepId ?? ''}`}
        machine={data.machine}
        procedure={data.procedure}
        linkTargets={data.linkTargets}
        initialStepId={initialStepId}
        onOpenProcedure={(slug, stepId) => {
          const query = stepId === undefined ? '' : `?${new URLSearchParams({ step: stepId })}`;
          void navigate(`/m/${encodeURIComponent(data.machine.slug)}/${encodeURIComponent(slug)}${query}`);
        }}
      />
    );
  }

  return (
    <main className="panel">
      <header className="panel-head">
        <Link to="/">All machines</Link>
        {loading && <p role="status">Loading procedure…</p>}
        {error && <p role="alert">Unable to load procedure: {error.message}</p>}
        {!loading && !error && !data && <p>Not found</p>}
      </header>
    </main>
  );
}

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { RequireRole } from '../auth/RequireRole';
import { useCatalog } from '../data/CatalogContext';
import { isConvexMode } from '../data/mode';
import { errorMessage } from '../lib/errorMessage';
import { useAsync } from '../lib/useAsync';
import { PlayerView } from '../player/PlayerView';
import type { PlayerViewProps } from '../player/PlayerView';

function RecordingPlayer(props: PlayerViewProps) {
  const complete = useMutation(api.training.complete);
  const [status, setStatus] = useState<'idle' | 'saving' | 'recorded' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const latestSubmission = useRef(0);
  const versionId = props.procedure.versionId;

  const onComplete = useCallback((checkpoints: { stepId: string; at: number }[]) => {
    const submission = ++latestSubmission.current;
    if (!versionId) {
      setStatus('error');
      setError('This procedure has no version to record.');
      return;
    }
    setStatus('saving');
    setError(null);
    void complete({ procedureVersionId: versionId as Id<'procedureVersions'>, checkpoints }).then(() => {
      if (submission === latestSubmission.current) setStatus('recorded');
    }).catch((cause: unknown) => {
      if (submission !== latestSubmission.current) return;
      setStatus('error');
      setError(errorMessage(cause));
    });
  }, [complete, versionId]);

  return (
    <div className="recording-player">
      <PlayerView {...props} onComplete={onComplete} />
      {status === 'saving' && <p className="notice" role="status">Recording completion…</p>}
      {status === 'recorded' && <p className="notice" role="status">Recorded</p>}
      {status === 'error' && <p className="notice error" role="alert">Unable to record completion: {error}</p>}
    </div>
  );
}

function VersionPreview({ versionId }: { versionId: Id<'procedureVersions'> }) {
  const { machine, procedure } = useParams<{ machine: string; procedure: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const version = useQuery(api.procedures.getVersion, { versionId });
  const machineRecord = useQuery(api.machines.getBySlug, machine ? { slug: machine } : 'skip');
  if (version === undefined || machineRecord === undefined) {
    return <p className="notice" role="status">Loading preview…</p>;
  }
  if (!machineRecord || version.machineSlug !== machine || version.procedureSlug !== procedure) {
    return <p className="notice" role="alert">This version does not belong to this procedure.</p>;
  }
  if (!version.modelUrl) return <p className="notice" role="alert">The machine model is unavailable.</p>;
  const initialStepId = searchParams.get('step') ?? undefined;
  return (
    <PlayerView
      key={`${versionId}/${initialStepId ?? ''}`}
      machine={{
        slug: machineRecord.slug, name: machineRecord.name, kind: machineRecord.kind,
        modelUrl: version.modelUrl, definition: version.definition,
      }}
      procedure={{
        slug: version.procedureSlug, machineSlug: version.machineSlug,
        content: version.content, versionId, placeholder: false,
      }}
      preview
      initialStepId={initialStepId}
      linkTargets={version.linkTargets}
      mediaUrls={version.mediaUrls}
      onOpenProcedure={(slug, stepId) => {
        const query = new URLSearchParams();
        if (slug === version.procedureSlug) query.set('version', versionId);
        if (stepId) query.set('step', stepId);
        const suffix = query.size > 0 ? `?${query}` : '';
        void navigate(`/m/${encodeURIComponent(version.machineSlug)}/${encodeURIComponent(slug)}${suffix}`);
      }}
    />
  );
}

function CatalogPlayer() {
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

    return {
      machine: { ...machineRecord, ...procedureRecord.machineVersion },
      procedure: procedureRecord,
      linkTargets,
    };
  }, [catalog, machine, procedure]);

  const initialStepId = searchParams.get('step') ?? undefined;
  if (!loading && !error && data) {
    const View = isConvexMode ? RecordingPlayer : PlayerView;
    return (
      <View
        key={`${data.machine.slug}/${data.procedure.slug}/${initialStepId ?? ''}`}
        machine={data.machine}
        procedure={data.procedure}
        linkTargets={data.linkTargets}
        mediaUrls={data.procedure.mediaUrls}
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

export function PlayerRoute() {
  const [searchParams] = useSearchParams();
  const versionId = searchParams.get('version');
  if (isConvexMode && versionId) {
    return <RequireRole minimum="author"><VersionPreview versionId={versionId as Id<'procedureVersions'>} /></RequireRole>;
  }
  return <CatalogPlayer />;
}

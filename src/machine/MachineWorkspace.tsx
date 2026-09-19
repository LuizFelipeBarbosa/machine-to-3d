import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { RequireRole } from '../auth/RequireRole';
import { ROLE_RANK } from '../auth/roles';
import { useMe } from '../auth/useMe';
import { useCatalog } from '../data/CatalogContext';
import type { MachineRecord, ProcedureRecord } from '../data/catalog';
import { isConvexMode } from '../data/mode';
import { errorMessage } from '../lib/errorMessage';
import { useAsync } from '../lib/useAsync';
import { PlayerPanel } from '../player/PlayerPanel';
import type { PlayerPanelProps } from '../player/PlayerPanel';
import { MachineScene } from '../scene';
import { ExplorePanel } from './ExplorePanel';
import { ProcedurePicker } from './ProcedurePicker';
import type { ProcedureSummary } from './ProcedurePicker';
import { useSceneController } from './useSceneController';
import type { SceneController } from './useSceneController';

type LoadedProcedure = {
  procedure: ProcedureRecord;
  linkTargets: Record<string, string[]>;
};

// This wrapper shares the scene's lifetime without changing the renderer itself.
function WorkspaceScene({ machine, controller, onInspect }: {
  machine: MachineRecord;
  controller: SceneController;
  onInspect(part: string | null): void;
}) {
  const counted = useRef(false);
  useEffect(() => {
    if (!import.meta.env.DEV || counted.current) return;
    counted.current = true;
    const debugWindow = window as Window & { __sceneMounts?: number };
    debugWindow.__sceneMounts = (debugWindow.__sceneMounts ?? 0) + 1;
  }, []);

  return (
    <MachineScene
      ref={controller.handle}
      modelUrl={machine.modelUrl}
      definition={machine.definition}
      state={controller.state}
      highlightedParts={controller.highlighted}
      initialView={undefined}
      onPickPart={onInspect}
    />
  );
}

function RecordingPlayer(props: PlayerPanelProps) {
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
    <>
      <PlayerPanel {...props} onComplete={onComplete} />
      {status === 'saving' && <p className="notice" role="status">Recording completion…</p>}
      {status === 'recorded' && <p className="notice" role="status">Recorded</p>}
      {status === 'error' && <p className="notice error" role="alert">Unable to record completion: {error}</p>}
    </>
  );
}

type SelectionProps = Omit<PlayerPanelProps, 'procedure' | 'linkTargets'> & {
  slug: string;
};

function VersionPreview({ versionId, slug, ...props }: SelectionProps & { versionId: Id<'procedureVersions'> }) {
  const version = useQuery(api.procedures.getVersion, { versionId });
  if (version === undefined) return <p className="notice" role="status">Loading preview…</p>;
  if (version.machineSlug !== props.machine.slug || version.procedureSlug !== slug) {
    return <p className="notice" role="alert">This version does not belong to this procedure.</p>;
  }
  if (!version.modelUrl) return <p className="notice" role="alert">The machine model is unavailable.</p>;

  return (
    <PlayerPanel
      {...props}
      key={slug}
      procedure={{
        slug, machineSlug: props.machine.slug, content: version.content,
        versionId, placeholder: false,
      }}
      preview
      linkTargets={version.linkTargets}
      mediaUrls={version.mediaUrls}
    />
  );
}

function SelectedProcedure({ slug, cache, ...props }: SelectionProps & { cache: Map<string, LoadedProcedure> }) {
  const catalog = useCatalog();
  const machineSlug = props.machine.slug;
  const result = useAsync(async () => {
    const cached = cache.get(slug);
    if (cached) return cached;
    const [procedure, linkTargets] = await Promise.all([
      catalog.getProcedure(machineSlug, slug),
      catalog.listStepIds(machineSlug),
    ]);
    if (!procedure) return null;
    const loaded = { procedure, linkTargets };
    cache.set(slug, loaded);
    return loaded;
  }, [catalog, machineSlug, slug, cache]);

  const loaded = cache.get(slug) ?? result.data;
  if (loaded) {
    const Panel = isConvexMode ? RecordingPlayer : PlayerPanel;
    return <Panel {...props} key={slug} {...loaded} mediaUrls={loaded.procedure.mediaUrls} />;
  }
  if (result.loading) return <p className="notice" role="status">Loading procedure…</p>;
  if (result.error) return <p className="notice" role="alert">Unable to load procedure: {result.error.message}</p>;
  return <p className="notice">Not found</p>;
}

type WorkspaceProps = {
  machine: MachineRecord;
  procedures: ProcedureSummary[];
  authorMachineId?: Id<'machines'>;
};

function LoadedWorkspace({ machine, procedures, authorMachineId }: WorkspaceProps) {
  const { procedure: selected } = useParams<{ procedure: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const controller = useSceneController(machine.definition);
  const [cache] = useState(() => new Map<string, LoadedProcedure>());
  const [inspected, setInspected] = useState<string | null>(null);
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  const [inspector, setInspector] = useState<HTMLDivElement | null>(null);
  const selectedPart = machine.definition.parts.find((part) => part.name === inspected);
  const versionId = isConvexMode ? searchParams.get('version') : null;
  const { setHighlighted } = controller;

  useEffect(() => {
    if (!selected) setHighlighted(inspected ? [inspected] : []);
  }, [selected, inspected, setHighlighted]);

  function openProcedure(slug: string, stepId?: string) {
    setInspected(null);
    const query = new URLSearchParams();
    if (slug && slug === selected && versionId) query.set('version', versionId);
    if (stepId) query.set('step', stepId);
    const suffix = query.size > 0 ? `?${query}` : '';
    const path = `/m/${encodeURIComponent(machine.slug)}`;
    void navigate(slug ? `${path}/${encodeURIComponent(slug)}${suffix}` : path);
  }

  const playerProps: SelectionProps = {
    machine, slug: selected ?? '', controller, viewport: { tools, inspector },
    inspected, onInspect: setInspected, onOpenProcedure: openProcedure,
    initialStepId: searchParams.get('step') ?? undefined,
  };

  return (
    <main className="app">
      <section className="viewport" aria-label="3D view of the instrument">
        <WorkspaceScene machine={machine} controller={controller} onInspect={setInspected} />
        <div className="vp-top">
          <div className="machine"><h1>{machine.name}</h1><p>{machine.kind}</p></div>
          <div className="tools" ref={setTools}>
            {!selected && <>
              {machine.definition.stateVars.map((variable) => (
                <label key={variable.name}>
                  <input
                    type="checkbox"
                    checked={Boolean(controller.state[variable.name])}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      controller.setState((state) => ({ ...state, [variable.name]: checked }));
                    }}
                  />
                  {variable.label}
                </label>
              ))}
              <button type="button" onClick={() => controller.handle.current?.resetView()}>Reset view</button>
            </>}
          </div>
        </div>
        <div ref={setInspector}>
          {!selected && selectedPart && (
            <div className="inspect">
              <button type="button" className="close" aria-label="Close part details" onClick={() => setInspected(null)}>×</button>
              <h2>{selectedPart.label}</h2>
              <p>{selectedPart.blurb}</p>
            </div>
          )}
        </div>
        <p className="hint">Drag to orbit, scroll to zoom, click a part to identify it</p>
      </section>
      <aside className="panel" aria-label={selected ? 'Procedure' : 'Explore'}>
        <ProcedurePicker machineSlug={machine.slug} authorMachineId={authorMachineId}
          procedures={procedures} selected={selected} onSelect={openProcedure} />
        {!selected ? (
          <ExplorePanel machine={machine} procedures={procedures} controller={controller}
            inspected={inspected} canEdit={Boolean(authorMachineId)} onInspect={setInspected} onOpenProcedure={openProcedure} />
        ) : versionId ? (
          <RequireRole minimum="author">
            <VersionPreview key={`${selected}/${versionId}`} {...playerProps} versionId={versionId as Id<'procedureVersions'>} />
          </RequireRole>
        ) : <SelectedProcedure key={selected} {...playerProps} cache={cache} />}
      </aside>
    </main>
  );
}

function ConvexWorkspace(props: WorkspaceProps) {
  const { me } = useMe();
  const canEdit = Boolean(me && ROLE_RANK[me.role] >= ROLE_RANK.author);
  const record = useQuery(api.machines.getBySlug, canEdit ? { slug: props.machine.slug } : 'skip');
  const authorProcedures = useQuery(api.procedures.listForMachine, canEdit && record ? { machineId: record._id } : 'skip');
  const procedures = authorProcedures?.map((procedure) => ({
    ...procedure,
    minutes: props.procedures.find((summary) => summary.slug === procedure.slug)?.minutes,
  })) ?? props.procedures;

  return <LoadedWorkspace {...props} procedures={procedures} authorMachineId={canEdit ? record?._id : undefined} />;
}

export function MachineWorkspace() {
  const { machine: slug } = useParams<{ machine: string }>();
  const catalog = useCatalog();
  const requests = useMemo(() => new Map<string, Promise<WorkspaceProps | null>>(), [catalog]);
  const { data, error, loading } = useAsync(async () => {
    if (!slug) return null;
    const existing = requests.get(slug);
    if (existing) return existing;

    const request = Promise.all([catalog.getMachine(slug), catalog.listMachines()]).then(([machine, machines]) => {
      if (!machine) return null;
      const procedures = machines.find((summary) => summary.slug === machine.slug)?.procedures ?? [];
      return { machine, procedures };
    }).catch((cause: unknown) => {
      requests.delete(slug);
      throw cause;
    });
    requests.set(slug, request);
    return request;
  }, [catalog, slug, requests]);

  if (!loading && !error && data) {
    const Workspace = isConvexMode ? ConvexWorkspace : LoadedWorkspace;
    return <Workspace key={data.machine.slug} {...data} />;
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

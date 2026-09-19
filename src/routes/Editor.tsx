import { useCallback, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { ProcedureContent } from '../../shared/procedure';
import { RequireRole } from '../auth/RequireRole';
import { ROLE_RANK } from '../auth/roles';
import { useMe } from '../auth/useMe';
import { useCatalog } from '../data/CatalogContext';
import { isConvexMode } from '../data/mode';
import { EditorView } from '../editor/EditorView';
import { VersionBar } from '../editor/VersionBar';
import type { AutosaveControls } from '../editor/useAutosave';
import { useAsync } from '../lib/useAsync';

type EditorContext = NonNullable<FunctionReturnType<typeof api.procedures.getEditorContext>>;
type Version = FunctionReturnType<typeof api.procedures.getVersion>;

function DraftEditor({ context, version, canApprove }: {
  context: EditorContext;
  version: Version;
  canApprove: boolean;
}) {
  const navigate = useNavigate();
  const saveDraft = useMutation(api.procedures.saveDraft);
  const discardDraft = useMutation(api.procedures.discardDraft);
  const approve = useMutation(api.procedures.approve);
  const createRevision = useMutation(api.draftJobs.createRevision);
  const [busy, setBusy] = useState(false);
  // Query updates acknowledge saves; they must not reload the author's working copy.
  // The parent keys by draft id and content revision so agent rewrites start a new session.
  const [initialVersion] = useState(version);
  const onSave = useCallback(async (content: ProcedureContent) => {
    await saveDraft({ versionId: version._id, content, expectedContentRevision: version.contentRevision });
  }, [saveDraft, version._id, version.contentRevision]);

  async function discard(autosave: AutosaveControls) {
    setBusy(true);
    await autosave.pause();
    try {
      await discardDraft({ versionId: version._id });
      if (context.versions.length === 1) {
        await navigate(`/m/${encodeURIComponent(context.machineSlug)}`);
      }
    } catch (error) {
      autosave.resume();
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function approveDraft(autosave: AutosaveControls, changeNote: string) {
    setBusy(true);
    await autosave.pause();
    try {
      if (!await autosave.flush()) throw new Error('Save the draft successfully before approving.');
      await approve({ versionId: version._id, changeNote });
    } catch (error) {
      autosave.resume();
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function reviseDraft(autosave: AutosaveControls, instruction: string) {
    setBusy(true);
    await autosave.pause();
    try {
      if (!await autosave.flush()) throw new Error('Save the draft successfully before sending it to the agent.');
      await createRevision({ procedureVersionId: version._id, instruction });
    } catch (error) {
      autosave.resume();
      throw error;
    } finally {
      setBusy(false);
    }
  }

  const activeJob = context.activeJob;

  return (
    <EditorView
      machine={{
        slug: context.machineSlug,
        name: context.machineName,
        kind: 'Procedure editor',
        modelUrl: initialVersion.modelUrl!,
        definition: initialVersion.definition,
      }}
      procedureSlug={version.procedureSlug}
      initialContent={initialVersion.content}
      linkTargets={context.linkTargets}
      procedureTitles={context.procedureTitles}
      mediaUrls={context.mediaUrls}
      disabled={busy}
      lockedMessage={activeJob ? `Agent revision in progress (${activeJob.stage}). Editing resumes when it finishes.` : undefined}
      lockedMessageHref={activeJob ? `/jobs/${activeJob._id}` : undefined}
      onSave={onSave}
      onPreview={async () => {
        await navigate(`/m/${encodeURIComponent(context.machineSlug)}/${encodeURIComponent(version.procedureSlug)}?${new URLSearchParams({ version: version._id })}`);
      }}
      headerSlot={(autosave) => (
        <VersionBar
          versions={context.versions}
          draftId={version._id}
          status={autosave.status}
          canApprove={canApprove}
          onDiscard={() => discard(autosave)}
          onApprove={(note) => approveDraft(autosave, note)}
          onRevise={activeJob ? undefined : (instruction) => reviseDraft(autosave, instruction)}
        />
      )}
    />
  );
}

function ConvexEditor() {
  const { machine, procedure } = useParams<{ machine: string; procedure: string }>();
  const { me } = useMe();
  const context = useQuery(api.procedures.getEditorContext,
    machine && procedure ? { machineSlug: machine, procedureSlug: procedure } : 'skip');
  const version = useQuery(api.procedures.getVersion,
    context?.draftId ? { versionId: context.draftId } : 'skip');
  const createDraft = useMutation(api.procedures.createDraft);

  async function startDraft(fromVersionId?: Id<'procedureVersions'>) {
    if (!context) return;
    await createDraft({ procedureId: context.procedureId, fromVersionId });
  }

  if (context === undefined) return <p className="notice" role="status">Loading editor…</p>;
  if (context === null) return <p className="notice">Procedure not found. <Link to="/">All machines</Link></p>;
  if (!context.draftId) {
    return (
      <main className="panel">
        <header className="panel-head">
          <Link to={`/m/${encodeURIComponent(context.machineSlug)}`}>{context.machineName}</Link>
          <h2>{context.procedureTitles[procedure ?? ''] ?? procedure}</h2>
          <p>Choose a version to start editing.</p>
          <VersionBar versions={context.versions} onCreateDraft={startDraft} />
        </header>
      </main>
    );
  }
  if (version === undefined) return <p className="notice" role="status">Loading draft…</p>;
  if (!version.modelUrl) return <p className="notice" role="alert">The machine model is unavailable.</p>;
  return (
    <DraftEditor
      key={`${version._id}:${version.contentRevision}`}
      context={context}
      version={version}
      canApprove={Boolean(me && ROLE_RANK[me.role] >= ROLE_RANK.approver)}
    />
  );
}

function LocalEditor() {
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

export function Editor() {
  return isConvexMode ? <RequireRole minimum="author"><ConvexEditor /></RequireRole> : <LocalEditor />;
}

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { contentHash } from '../shared/contentHash.js';
import { MachineDefinitionSchema, referencedClips, type MachineDefinition } from '../shared/machine.js';
import { ProcedureContentSchema, type ProcedureContent } from '../shared/procedure.js';
import { validateProcedure, type LinkTargets } from '../shared/validateProcedure.js';
import { runCodexWithFallback, type CodexRunOptions, type CodexRunResult } from './codex.js';
import { stepViews } from './frameView.js';
import { validateWorkspace } from './kit/validate.js';
import type { ClaimedJob, DeliverPayload, EventLevel, WorkerClient } from './types.js';
import { prepareWorkspace } from './workspace.js';

const TRANSIENT_UPSTREAM_ERROR = /503|Service Unavailable|server_is_overloaded|auth_unavailable|overloaded|rate.?limit|429/i;

export type PipelineOptions = {
  home: string;
  repoRoot: string;
  codex?: Partial<CodexRunOptions>;
  retryDelayMs?: number;
  runExtract?: boolean;
  fetch?: typeof fetch;
};

type JobContext = {
  client: WorkerClient;
  log: (level: EventLevel, message: string) => Promise<void>;
  signal: AbortSignal;
};

export async function runJob(job: ClaimedJob, context: JobContext, options: PipelineOptions): Promise<void> {
  const { client } = context;
  try {
    if (!await startStage(job.jobId, 'workspace', context)) return;
    const { dir, taskPrompt, videoFile } = await prepareWorkspace(job, {
      home: options.home, repoRoot: options.repoRoot, fetch: options.fetch,
    });

    let images: string[] | undefined;
    if (job.kind === 'create' && videoFile !== null && options.runExtract !== false) {
      if (!await startStage(job.jobId, 'extract', context)) return;
      images = await extractFrames(dir, videoFile, job.procedureSlug, options.repoRoot);
    }

    if (!await startStage(job.jobId, 'codex', context)) return;
    const result = await generateOutputs(job, context, {
      workspace: dir, prompt: taskPrompt, images,
      resumeSessionId: job.kind === 'revise' ? job.codexSessionId : undefined,
      outputSchemaPath: join(options.repoRoot, 'worker/kit/report.schema.json'),
      signal: context.signal,
      ...options.codex,
    }, options.retryDelayMs);
    if (result === null) return;

    if (!await startStage(job.jobId, 'verify', context)) return;
    const { glb, definition, content, modelChanged } = await verifyOutputs(job, dir, options.repoRoot, result);

    if (!await startStage(job.jobId, 'frame', context)) return;
    const framedContent = stepViews(glb, assignStepIds(job, content), definition);

    if (!await startStage(job.jobId, 'upload', context)) return;
    const { model, mediaFileIds } = await uploadOutputs(job.jobId, client, dir, {
      glb, definition, content: framedContent, modelChanged,
    });

    if (!await startStage(job.jobId, 'deliver', context)) return;
    await client.deliver(job.jobId, {
      modelChanged, model, procedure: { content: framedContent }, mediaFileIds,
      sourceContentHash: job.target?.contentHash, report: result.report,
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

async function startStage(jobId: string, stage: string, context: JobContext): Promise<boolean> {
  if (context.signal.aborted) return false;
  await context.client.stage(jobId, stage);
  await context.log('info', `Starting ${stage} stage`);
  return !context.signal.aborted;
}

const execFileAsync = promisify(execFile);

async function runCommand(label: string, command: string, args: string[], dir: string): Promise<void> {
  try {
    await execFileAsync(command, args, { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(`${label} failed: ${failure.stderr?.trim() || failure.message || String(error)}`);
  }
}

async function extractFrames(dir: string, videoFile: string, slug: string, repoRoot: string): Promise<string[]> {
  await runCommand('Video extraction', 'bash', [
    join(repoRoot, 'worker/kit/extract.sh'), videoFile, `videos/${slug}`,
  ], dir);
  const frameDir = join(dir, 'videos', slug, 'frames');
  const frames = JSON.parse(await readFile(join(frameDir, 'index.json'), 'utf8')) as {
    file: string; seconds: number;
  }[];
  const count = Math.min(6, frames.length);
  const selected = Array.from({ length: count }, (_, index) =>
    frames[count === 1 ? 0 : Math.round(index * (frames.length - 1) / (count - 1))].file);
  return [...new Set(selected)].map(file => join(frameDir, file));
}

async function generateOutputs(
  job: ClaimedJob, context: JobContext, options: CodexRunOptions, retryDelayMs?: number,
): Promise<CodexRunResult | null> {
  const recentTexts: string[] = [];
  let sawTransientUpstreamError = false;
  let sessionId: string | null = options.resumeSessionId ?? null;
  let notifications = Promise.resolve();
  let notificationError: Error | undefined;
  const runOptions: CodexRunOptions = {
    ...options,
    onEvent: event => {
      if (event.text !== undefined && event.text.trim()) {
        sawTransientUpstreamError ||= TRANSIENT_UPSTREAM_ERROR.test(event.text);
        recentTexts.push(event.text);
        if (recentTexts.length > 3) recentTexts.shift();
      }
      const detectedId = findSessionId(event.raw);
      const newSession = detectedId !== null && detectedId !== sessionId;
      if (detectedId !== null) sessionId = detectedId;
      // The CLI callback is synchronous. Serialize and settle async notifications before advancing.
      notifications = notifications.then(async () => {
        if (event.text !== undefined) await context.log('info', event.text.slice(0, 500));
        if (newSession) await context.client.stage(job.jobId, 'codex', detectedId!);
      }).catch(error => {
        notificationError ??= new Error(error instanceof Error ? error.message : String(error));
      });
    },
  };

  async function attempt(attemptOptions: CodexRunOptions): Promise<CodexRunResult> {
    let result: CodexRunResult;
    try {
      result = await runCodexWithFallback(attemptOptions);
    } finally {
      await notifications;
    }
    if (notificationError) throw notificationError;
    sessionId = result.sessionId ?? sessionId;
    if (sessionId !== null) await context.client.stage(job.jobId, 'codex', sessionId);
    return result;
  }

  let result = await attempt(runOptions);
  let resumeFallbackUsed = false;
  let transientRetryUsed = false;
  while (result.exitCode !== 0 && result.report === null
    && !result.aborted && !result.timedOut && !context.signal.aborted) {
    const diagnostics = [result.finalMessage, result.stderr, ...recentTexts].join('\n');
    const mentionsResumeFailure = /session|resume|not found|no such/i.test(diagnostics);
    const shouldFallbackResume = runOptions.resumeSessionId !== undefined
      && !resumeFallbackUsed
      && (result.durationMs <= 60_000 || mentionsResumeFailure);
    if (shouldFallbackResume) {
      resumeFallbackUsed = true;
      await context.log('warn', 'Resume failed; starting a fresh session');
      result = await attempt({ ...runOptions, resumeSessionId: undefined });
      continue;
    }

    if (!transientRetryUsed
      && (sawTransientUpstreamError || TRANSIENT_UPSTREAM_ERROR.test(diagnostics))) {
      transientRetryUsed = true;
      const delay = Math.max(0, retryDelayMs ?? 90_000);
      const provider = runOptions.provider ?? 'cliproxyapi';
      const retryProvider = provider === 'cliproxyapi' ? 'default' : provider;
      const retryMessage = provider === 'cliproxyapi'
        ? `Upstream overloaded via cliproxyapi; retrying directly in ${delay / 1000}s`
        : `Upstream overloaded; retrying in ${delay / 1000}s`;
      await context.log('warn', retryMessage);
      if (!await waitForRetry(delay, context.signal)) return null;
      if (context.signal.aborted) return null;
      result = await attempt({ ...runOptions, provider: retryProvider,
        resumeSessionId: sessionId ?? undefined });
      continue;
    }
    break;
  }

  if (context.signal.aborted) return null;
  if (result.timedOut || result.aborted || result.exitCode !== 0) {
    const reason = result.aborted ? 'aborted' : result.timedOut ? 'timed out' : `failed with exit code ${result.exitCode}`;
    throw new Error(`Codex ${reason}. Last event texts (${recentTexts.length} of 3): ${recentTexts.join('; ') || '(none)'}`);
  }
  if (result.report === null) throw new Error('Codex did not return a JSON report');
  const report = result.report as { status?: string; notes?: string };
  if (report.status === 'blocked') throw new Error(`Codex blocked: ${report.notes}`);
  return result;
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (delayMs <= 0) return true;
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function findSessionId(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['thread_id', 'session_id', 'conversation_id']) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  if ((record.type === 'thread.started' || record.type === 'session.created')
    && typeof record.id === 'string' && record.id) return record.id;
  for (const child of Object.values(record)) {
    const id = findSessionId(child);
    if (id !== null) return id;
  }
  return null;
}

async function verifyOutputs(job: ClaimedJob, dir: string, repoRoot: string, result: CodexRunResult) {
  await runCommand('Model export', process.execPath, [
    '--import', 'tsx', join(repoRoot, 'scripts/export-model.ts'), 'buildModel.ts', '--out', 'model.glb',
  ], dir);
  const { issues } = validateWorkspace(dir);
  const glb = await readFile(join(dir, 'model.glb'));
  const definition = MachineDefinitionSchema.parse(JSON.parse(await readFile(join(dir, 'machine.json'), 'utf8')));
  const content = ProcedureContentSchema.parse(JSON.parse(
    await readFile(join(dir, 'procedures', `${job.procedureSlug}.json`), 'utf8'),
  ));
  const report = result.report as { modelChanged?: boolean; notes?: string; [key: string]: unknown };
  const current = job.machine.current;
  const modelChanged = !current || report.modelChanged === true
    || contentHash(definition) !== contentHash(current.definition);
  if (modelChanged && current) checkAdditiveModel(current.definition as MachineDefinition, definition);

  const linkTargets: LinkTargets = Object.fromEntries(job.approvedProcedures.map(({ slug, content }) =>
    [slug, (content as ProcedureContent).steps.map(step => step.id)]));
  linkTargets[job.procedureSlug] = content.steps.map(step => step.id);
  const allowedStartIssues = new Set<string>();
  for (const { slug, content: approvedContent } of job.approvedProcedures) {
    const approvedIssues = validateProcedure(approvedContent as ProcedureContent, definition, linkTargets);
    const remaining = approvedIssues.filter(issue => issue.path !== 'start' && !issue.path.startsWith('start.'));
    if (remaining.length > 0) {
      throw new Error(`Approved procedure "${slug}" breaks on the new model: ${remaining.map(issue =>
        `${issue.path}: ${issue.message}`).join(', ')}`);
    }
    // validateWorkspace also checks approved copies. Only their reference-level start issues
    // are exempt; schema errors and every issue in the generated procedure remain blocking.
    if (slug !== job.procedureSlug) {
      for (const issue of approvedIssues) {
        allowedStartIssues.add(`procedures/${slug}.json.${issue.path}: ${issue.message}`);
      }
    }
  }
  const blockingIssues = issues.filter(issue => !allowedStartIssues.has(issue));
  if (blockingIssues.length > 0) throw new Error(blockingIssues.join('; '));
  return { glb, definition, content, modelChanged };
}

function checkAdditiveModel(previous: MachineDefinition, definition: MachineDefinition): void {
  const groups = [
    { kind: 'part', before: previous.parts.map(part => part.name), after: definition.parts.map(part => part.name) },
    { kind: 'state var', before: previous.stateVars.map(state => state.name), after: definition.stateVars.map(state => state.name) },
    { kind: 'clip', before: referencedClips(previous), after: referencedClips(definition) },
  ];
  const missing: string[] = [];
  for (const { kind, before, after } of groups) {
    const names = new Set(after);
    for (const name of before) {
      if (!names.has(name)) missing.push(`${kind} "${name}"`);
    }
  }
  if (missing.length > 0) throw new Error(`Model change is not additive: missing ${missing.join(', ')}`);
}

function assignStepIds(job: ClaimedJob, content: ProcedureContent): ProcedureContent {
  const previous = job.kind === 'revise' && job.target ? (job.target.content as ProcedureContent).steps : [];
  const usedIds = new Set(previous.map(step => step.id));
  const reusedIds = new Set<string>();
  let next = 1;
  return {
    ...content,
    steps: content.steps.map(step => {
      const match = previous.find(old => old.title === step.title && old.body === step.body && !reusedIds.has(old.id));
      if (match) {
        reusedIds.add(match.id);
        return { ...step, id: match.id };
      }
      let id: string;
      do {
        id = `${job.procedureSlug}-${String(next++).padStart(2, '0')}`;
      } while (usedIds.has(id));
      usedIds.add(id);
      return { ...step, id };
    }),
  };
}

async function uploadOutputs(
  jobId: string, client: WorkerClient, dir: string,
  outputs: { glb: Uint8Array; definition: MachineDefinition; content: ProcedureContent; modelChanged: boolean },
) {
  const mediaFileIds: string[] = [];
  for (const step of outputs.content.steps) {
    if (!step.media?.fileId.startsWith('videos/')) continue;
    const bytes = await readFile(join(dir, step.media.fileId));
    const id = await client.uploadFile(jobId, bytes, 'image/jpeg');
    step.media.fileId = id;
    mediaFileIds.push(id);
  }

  let model: DeliverPayload['model'];
  if (outputs.modelChanged) {
    const modelFileId = await client.uploadFile(jobId, outputs.glb, 'model/gltf-binary');
    const bundleJson = JSON.stringify({
      'buildModel.ts': await readFile(join(dir, 'buildModel.ts'), 'utf8'),
      'machine.json': await readFile(join(dir, 'machine.json'), 'utf8'),
    });
    const sourceFileId = await client.uploadFile(jobId, Buffer.from(bundleJson), 'application/json');
    model = { modelFileId, sourceFileId, definition: outputs.definition };
  }
  return { model, mediaFileIds };
}

import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeGlb } from '../scripts/lib/glb.js';
import { MachineDefinitionSchema } from '../shared/machine.js';
import type { ProcedureContent } from '../shared/procedure.js';
import { validateProcedure } from '../shared/validateProcedure.js';
import { runCodex } from './codex.js';
import * as codex from './codex.js';
import { runJob, type PipelineOptions } from './pipeline.js';
import type { ClaimedJob, DeliverPayload, EventLevel, WorkerClient } from './types.js';

const repoRoot = process.cwd();
const stubPath = resolve('worker/fixtures/stub-codex.mjs');
const fakePath = resolve('worker/fixtures/fake-codex.mjs');
const templateSource = readFileSync(resolve('worker/kit/template/buildModel.ts'), 'utf8');
const templateJson = readFileSync(resolve('worker/kit/template/machine.json'), 'utf8');
const definition = MachineDefinitionSchema.parse(JSON.parse(templateJson));
const templateGlb = readFileSync(resolve('worker/kit/template/model.glb'));
const pathFfmpeg = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout?.trim();
const ffmpeg = pathFfmpeg || (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : undefined);
const hasFfmpeg = Boolean(ffmpeg);

function createJob(): ClaimedJob {
  return {
    jobId: 'job-1', kind: 'create', stage: 'queued', attempts: 1, workspaceKey: 'machine-1',
    machine: { slug: 'kit-box', name: 'Kit box', kind: 'instrument' },
    procedureSlug: 'demo', title: 'Inspect the kit box', brief: '',
    approvedProcedures: [], leaseSeconds: 90,
  };
}

type RecordingClient = WorkerClient & {
  stages: { jobId: string; stage: string; sessionId?: string }[];
  events: { jobId: string; level: EventLevel; message: string }[];
  deliveries: { jobId: string; payload: DeliverPayload }[];
  failures: { jobId: string; error: string }[];
  uploads: { jobId: string; bytes: Uint8Array; contentType: string }[];
};

function createClient(): RecordingClient {
  const stages: RecordingClient['stages'] = [];
  const events: RecordingClient['events'] = [];
  const deliveries: RecordingClient['deliveries'] = [];
  const failures: RecordingClient['failures'] = [];
  const uploads: RecordingClient['uploads'] = [];
  return {
    stages, events, deliveries, failures, uploads,
    async claim() { return null; },
    async heartbeat() { return { status: 'running' }; },
    async stage(jobId, stage, sessionId) { stages.push({ jobId, stage, sessionId }); },
    async event(jobId, level, message) { events.push({ jobId, level, message }); },
    async uploadFile(jobId, bytes, contentType) {
      uploads.push({ jobId, bytes: new Uint8Array(bytes), contentType });
      return `file-${uploads.length}`;
    },
    async deliver(jobId, payload) {
      deliveries.push({ jobId, payload });
      return { procedureVersionId: 'procedure-2', machineVersionId: 'machine-2' };
    },
    async fail(jobId, error) { failures.push({ jobId, error }); },
  };
}

function procedure(): ProcedureContent {
  return {
    formatVersion: 1, title: 'Inspect the kit box', summary: 'Open the door.', minutes: 2,
    start: { doorOpen: false },
    steps: [{
      id: 'demo-07', title: 'Open the door', body: 'Swing the door open.', where: 'instrument',
      parts: ['door'], view: { pos: [0, 0, 0], target: [0, 0, 0] }, state: { doorOpen: true },
    }],
  };
}

describe('runJob', () => {
  let home: string;
  let job: ClaimedJob;
  let client: RecordingClient;
  let controller: AbortController;
  let options: PipelineOptions;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'worker-pipeline-'));
    job = createJob();
    client = createClient();
    controller = new AbortController();
    options = {
      home, repoRoot, runExtract: false,
      codex: {
        command: process.execPath, commandArgsPrefix: [stubPath],
        env: { STUB_MODE: '', STUB_PROCEDURE_SLUG: 'demo' },
      },
      fetch: async () => { throw new Error('Unexpected network request'); },
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  function run() {
    return runJob(job, {
      client, log: (level, message) => client.event(job.jobId, level, message), signal: controller.signal,
    }, options);
  }

  function useExistingMachine(currentDefinition = definition) {
    job.machine.current = {
      machineVersionId: 'machine-1', version: 1, definition: currentDefinition,
      modelUrl: 'https://storage.example/model', sourceUrl: 'https://storage.example/source',
    };
    options.fetch = async url => {
      expect(url).toBe(job.machine.current?.sourceUrl);
      return Response.json({ 'buildModel.ts': templateSource, 'machine.json': templateJson });
    };
  }

  function revise(content = procedure()) {
    useExistingMachine();
    job.kind = 'revise';
    job.codexSessionId = 'previous-session';
    job.target = {
      procedureVersionId: 'procedure-1', machineVersionId: 'machine-1', content, definition,
      contentHash: 'hash-xyz', modelUrl: 'https://storage.example/model',
    };
  }

  it('exports, validates, frames, uploads and delivers a new machine in stage order', async () => {
    await run();
    expect(client.stages.map(call => call.stage)).toEqual([
      'workspace', 'codex', 'codex', 'codex', 'verify', 'frame', 'upload', 'deliver',
    ]);
    expect(client.stages.filter(call => call.sessionId)).toEqual([
      { jobId: job.jobId, stage: 'codex', sessionId: 'stub-session' },
      { jobId: job.jobId, stage: 'codex', sessionId: 'stub-session' },
    ]);
    expect(client.events.map(event => event.message)).toEqual(
      ['workspace', 'codex', 'verify', 'frame', 'upload', 'deliver'].map(stage => `Starting ${stage} stage`),
    );
    expect(client.deliveries).toHaveLength(1);
    const payload = client.deliveries[0].payload;
    expect(payload).toMatchObject({
      modelChanged: true, model: { modelFileId: 'file-1', sourceFileId: 'file-2', definition },
      mediaFileIds: [], report: { status: 'complete', notes: 'stub' },
    });
    const content = payload.procedure.content as ProcedureContent;
    expect(content.steps.map(step => step.id)).toEqual(['demo-01', 'demo-02']);
    for (const step of content.steps) expect(step.view.pos).not.toEqual([0, 0, 0]);
    expect(client.uploads.map(upload => upload.contentType)).toEqual(['model/gltf-binary', 'application/json']);
    expect(summarizeGlb(client.uploads[0].bytes)).toEqual(summarizeGlb(templateGlb));
    expect(JSON.parse(Buffer.from(client.uploads[1].bytes).toString())).toEqual({
      'buildModel.ts': templateSource, 'machine.json': templateJson,
    });
    expect(client.failures).toEqual([]);
  });

  it('uploads an identical existing definition when the report says the model changed', async () => {
    useExistingMachine();
    await run();
    expect(client.deliveries[0].payload).toMatchObject({
      modelChanged: true, model: { modelFileId: 'file-1', sourceFileId: 'file-2', definition },
    });
    expect(client.uploads).toHaveLength(2);
  });

  it('rejects renaming an existing door and leaves failure reporting to the caller', async () => {
    useExistingMachine();
    options.codex!.env!.STUB_MODE = 'rename-door';
    await expect(run()).rejects.toThrow('door');
    expect(client.deliveries).toEqual([]);
    expect(client.failures).toEqual([]);
  });

  it('reports all removed part, state variable and clip names together', async () => {
    const previous = structuredClone(definition);
    previous.parts.push({ name: 'handle', label: 'Handle', blurb: '' });
    previous.stateVars.push({
      name: 'handleUp', label: 'Handle up', kind: 'toggle', effects: [{ type: 'clip', clip: 'liftHandle' }],
    });
    useExistingMachine(previous);
    await expect(run()).rejects.toThrow(
      'Model change is not additive: missing part "handle", state var "handleUp", clip "liftHandle"',
    );
    expect(client.deliveries).toEqual([]);
  });

  it('identifies an approved procedure that references a missing part', async () => {
    useExistingMachine();
    const approved = procedure();
    approved.steps[0].parts = ['missing-handle'];
    job.approvedProcedures = [{ slug: 'approved-inspection', content: approved }];
    await expect(run()).rejects.toThrow('Approved procedure "approved-inspection" breaks on the new model');
    expect(client.deliveries).toEqual([]);
  });

  it('permits an approved procedure missing only an initial value for a newly added state var', async () => {
    const oldDefinition = { ...definition, stateVars: [] };
    useExistingMachine(oldDefinition);
    const approved = procedure();
    approved.start = {};
    delete approved.steps[0].state;
    expect(validateProcedure(approved, oldDefinition)).toEqual([]);
    expect(validateProcedure(approved, definition).map(issue => issue.path)).toEqual(['start.doorOpen']);
    job.approvedProcedures = [{ slug: 'older-inspection', content: approved }];
    await run();
    expect(client.deliveries).toHaveLength(1);
    expect(approved.start).toEqual({});
  });

  it('keeps approved step state errors blocking even when its start also needs updating', async () => {
    useExistingMachine();
    const approved = procedure();
    approved.start = {};
    approved.steps[0].state = { unknown: true };
    job.approvedProcedures = [{ slug: 'bad-state', content: approved }];
    await expect(run()).rejects.toThrow('Approved procedure "bad-state" breaks on the new model: steps[0].state.unknown');
    expect(client.deliveries).toEqual([]);
  });

  it('rejects a blocked report before exporting or uploading', async () => {
    options.codex!.env!.STUB_MODE = 'blocked';
    await expect(run()).rejects.toThrow(/^Codex blocked:/);
    expect(client.stages.some(call => call.stage === 'verify')).toBe(false);
    expect(client.uploads).toEqual([]);
    expect(client.deliveries).toEqual([]);
  });

  it('resumes revisions, carries the source hash, and reuses matching step ids', async () => {
    revise();
    await run();
    const payload = client.deliveries[0].payload;
    expect(payload.report).toMatchObject({ notes: 'stub (resumed)' });
    expect(payload.sourceContentHash).toBe('hash-xyz');
    const content = payload.procedure.content as ProcedureContent;
    expect(content.steps.map(step => step.id)).toEqual(['demo-07', 'demo-01']);
    expect(content.steps[0].view.pos).not.toEqual([0, 0, 0]);
    expect((job.target!.content as ProcedureContent).steps[0].view.pos).toEqual([0, 0, 0]);
  });

  it('retries an early missing-session error once without resume and delivers the fresh result', async () => {
    revise();
    const runner = vi.spyOn(codex, 'runCodexWithFallback').mockImplementationOnce(async runOptions => {
      runOptions.onEvent?.({ type: 'error', text: 'Resume session not found', raw: null });
      return {
        sessionId: 'previous-session', finalMessage: '', stderr: '', report: null,
        exitCode: 1, durationMs: 100, timedOut: false, aborted: false,
      };
    });
    await run();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0][0].resumeSessionId).toBe('previous-session');
    expect(runner.mock.calls[1][0].resumeSessionId).toBeUndefined();
    expect(runner.mock.calls[1][0].commandArgsPrefix).toEqual([stubPath]);
    expect(client.events.some(event => event.message === 'Resume session not found')).toBe(true);
    expect(client.deliveries[0].payload.report).toMatchObject({ notes: 'stub' });
    expect(client.stages.filter(stage => stage.sessionId).at(-1)?.sessionId).toBe('stub-session');
  });

  it('falls back from a resume failure reported on stderr', async () => {
    revise();
    options.codex!.env!.STUB_MODE = 'resume-fails';
    await run();
    expect(client.events).toContainEqual({
      jobId: job.jobId, level: 'warn', message: 'Resume failed; starting a fresh session',
    });
    expect(client.deliveries).toHaveLength(1);
  });

  it('retries an overloaded upstream once and delivers the second result', async () => {
    options.codex!.env!.STUB_MODE = 'fail-503-once';
    options.retryDelayMs = 10;
    await run();
    expect(client.events.some(event => event.level === 'warn'
      && event.message === 'Upstream overloaded via cliproxyapi; retrying directly in 0.01s')).toBe(true);
    expect(client.deliveries).toHaveLength(1);
    const report = client.deliveries[0].payload.report as { argv?: string[] };
    const argv = Array.isArray(report.argv) ? report.argv : [];
    expect(argv.some(arg => /model_provider/.test(arg))).toBe(false);
  });

  it('fails after one retry when the upstream remains overloaded', async () => {
    options.codex!.env!.STUB_MODE = 'fail-503';
    options.retryDelayMs = 10;
    await expect(run()).rejects.toThrow('Codex failed with exit code 1');
    expect(client.deliveries).toEqual([]);
  });

  it('stops without delivering when aborted during an overload retry wait', async () => {
    options.codex!.env!.STUB_MODE = 'fail-503';
    options.retryDelayMs = 90_000;
    const event = client.event;
    client.event = async (...args) => {
      await event(...args);
      if (args[2] === 'Upstream overloaded via cliproxyapi; retrying directly in 90s') controller.abort();
    };
    await expect(run()).resolves.toBeUndefined();
    expect(client.deliveries).toEqual([]);
  });

  it('stops after one fresh retry and includes the last three diagnostic texts', async () => {
    revise();
    const runner = vi.spyOn(codex, 'runCodexWithFallback').mockImplementation(async runOptions => {
      for (const text of ['initial diagnostic', 'session unavailable', 'no such session', 'resume failed']) {
        runOptions.onEvent?.({ type: 'error', text, raw: null });
      }
      return {
        sessionId: null, finalMessage: '', stderr: '', report: null,
        exitCode: 1, durationMs: 100, timedOut: false, aborted: false,
      };
    });
    await expect(run()).rejects.toThrow(
      'Codex failed with exit code 1. Last event texts (3 of 3): session unavailable; no such session; resume failed',
    );
    expect(runner).toHaveBeenCalledTimes(2);
    expect(client.deliveries).toEqual([]);
    expect(client.failures).toEqual([]);
  });

  it('reserves previous step ids before allocating ids for earlier new steps', async () => {
    const target = procedure();
    target.steps[0] = {
      ...target.steps[0], id: 'demo-01', title: 'Record the inspection',
      body: 'Record the result in the logbook.', where: 'logbook', parts: [],
    };
    revise(target);
    await run();
    const content = client.deliveries[0].payload.procedure.content as ProcedureContent;
    expect(content.steps.map(step => step.id)).toEqual(['demo-02', 'demo-01']);
  });

  it('returns cleanly when aborted before the pipeline starts', async () => {
    controller.abort();
    await expect(run()).resolves.toBeUndefined();
    expect(client.stages).toEqual([]);
    expect(client.deliveries).toEqual([]);
    expect(client.failures).toEqual([]);
  });

  it('returns cleanly when cancellation arrives while announcing the next stage', async () => {
    const stage = client.stage;
    client.stage = async (...args) => {
      await stage(...args);
      if (args[1] === 'codex') controller.abort();
    };
    await expect(run()).resolves.toBeUndefined();
    expect(client.stages.map(call => call.stage)).toEqual(['workspace', 'codex']);
    expect(client.deliveries).toEqual([]);
    expect(client.failures).toEqual([]);
  });

  it('includes exporter stderr on a failed re-export', async () => {
    const dir = join(home, 'machines', job.workspaceKey);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'buildModel.ts'), 'throw new Error("broken model source");');
    await writeFile(join(dir, 'machine.json'), templateJson);
    await expect(run()).rejects.toThrow('Model export failed: export-model: broken model source');
    expect(client.uploads).toEqual([]);
    expect(client.deliveries).toEqual([]);
  });

  it.skipIf(!hasFfmpeg)('extracts a synthetic six-second video and uploads the referenced frame', async () => {
    const videoDir = join(home, 'machines', job.workspaceKey, 'videos', job.procedureSlug);
    await mkdir(videoDir, { recursive: true });
    await promisify(execFile)(ffmpeg!, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:size=96x64:rate=10',
      '-t', '6', '-c:v', 'mpeg4', '-q:v', '5', join(videoDir, 'input.mp4'),
    ]);
    delete options.runExtract;
    await run();
    const frames = JSON.parse(await readFile(join(videoDir, 'frames/index.json'), 'utf8')) as {
      file: string; seconds: number;
    }[];
    expect(frames.map(frame => frame.seconds)).toEqual([0, 5]);
    for (const frame of frames) expect((await readFile(join(videoDir, 'frames', frame.file))).length).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(join(videoDir, 'transcript.json'), 'utf8')).segments).toEqual([]);
    expect(client.stages.map(call => call.stage)).toContain('extract');
    const payload = client.deliveries[0].payload;
    expect((payload.procedure.content as ProcedureContent).steps[0].media?.fileId).toBe('file-1');
    expect(payload.mediaFileIds).toEqual(['file-1']);
    expect(payload.model).toMatchObject({ modelFileId: 'file-2', sourceFileId: 'file-3' });
    expect(client.uploads[0].contentType).toBe('image/jpeg');
    expect(Buffer.from(client.uploads[0].bytes)).toEqual(await readFile(join(videoDir, 'frames', frames[0].file)));
  }, 60_000);

  it.each(['before spawn', 'during execution'])('aborts the Codex child %s', async when => {
    if (when === 'before spawn') controller.abort();
    const result = await runCodex({
      workspace: home, prompt: 'Abort the fixture', signal: controller.signal, timeoutMs: 2_000,
      command: process.execPath, commandArgsPrefix: [fakePath],
      env: { FAKE_CODEX_MODE: 'hang', FAKE_CODEX_SESSION_EVENT: '' },
      onEvent: () => controller.abort(),
    });
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });
});

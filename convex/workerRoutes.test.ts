import { readFileSync } from 'node:fs';
import { anyApi } from 'convex/server';
import type { ApiFromModules } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as draftJobs from './draftJobs';
import { emptyProcedureContent, parseDefinition } from './lib/content';
import schema from './schema';
import { asUser, createUser, modules } from './test.setup';

const api = anyApi as unknown as ApiFromModules<{ draftJobs: typeof draftJobs }>;
const workerId = 'worker-1';
const headers = { 'X-Worker-Secret': 'test-secret', 'Content-Type': 'application/json' };
const paths = [
  '/worker/claim', '/worker/heartbeat', '/worker/event', '/worker/stage',
  '/worker/upload-url', '/worker/deliver', '/worker/fail',
];
const templateDefinition = parseDefinition(JSON.parse(readFileSync(
  new URL('../worker/kit/template/machine.json', import.meta.url), 'utf8',
)));

function post(body: unknown): RequestInit {
  return { method: 'POST', headers, body: JSON.stringify(body) };
}

async function setup(options: { claim?: boolean } = {}) {
  vi.stubEnv('WORKER_SECRET', 'test-secret');
  const t = convexTest(schema, modules);
  const authorId = await createUser(t, { email: 'author@example.com', role: 'author' });
  const author = asUser(t, authorId);
  const videoFileId = await t.run((ctx) => ctx.storage.store(new Blob(['video'])));
  const title = 'From video';
  const jobId = await author.mutation(api.draftJobs.create, {
    newMachine: { slug: 'new-machine', name: 'New machine', kind: 'instrument' },
    procedureSlug: 'from-video', title, brief: 'Explain the workflow', videoFileId,
  });
  if (options.claim) {
    const response = await t.fetch('/worker/claim', post({ workerId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jobId });
  }
  return { t, author, jobId, title };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('worker authentication', () => {
  test.each(paths)('%s rejects a missing secret before reading the body', async (path) => {
    vi.stubEnv('WORKER_SECRET', 'test-secret');
    const t = convexTest(schema, modules);
    const response = await t.fetch(path, { method: 'POST', body: 'not JSON' });
    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  test.each(paths)('%s rejects an incorrect secret', async (path) => {
    vi.stubEnv('WORKER_SECRET', 'test-secret');
    const t = convexTest(schema, modules);
    const response = await t.fetch(path, {
      ...post({ workerId }), headers: { 'X-Worker-Secret': 'wrong-secret' },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  test('rejects an empty header when WORKER_SECRET is unset', async () => {
    const originalSecret = process.env.WORKER_SECRET;
    delete process.env.WORKER_SECRET;
    try {
      const t = convexTest(schema, modules);
      const response = await t.fetch('/worker/claim', {
        ...post({ workerId }), headers: { 'X-Worker-Secret': '' },
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    } finally {
      if (originalSecret === undefined) delete process.env.WORKER_SECRET;
      else process.env.WORKER_SECRET = originalSecret;
    }
  });

  test('rejects an empty configured secret even with an empty header', async () => {
    vi.stubEnv('WORKER_SECRET', '');
    const t = convexTest(schema, modules);
    const response = await t.fetch('/worker/claim', {
      ...post({ workerId }), headers: { 'X-Worker-Secret': '' },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });
});

describe('worker HTTP methods', () => {
  test.each(paths)('%s rejects non-POST methods', async (path) => {
    vi.stubEnv('WORKER_SECRET', 'test-secret');
    const t = convexTest(schema, modules);
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      const response = await t.fetch(path, { method, headers });
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
    }
  });
});

describe('worker body validation and errors', () => {
  test.each(paths)('%s rejects malformed JSON', async (path) => {
    vi.stubEnv('WORKER_SECRET', 'test-secret');
    const t = convexTest(schema, modules);
    const response = await t.fetch(path, { method: 'POST', headers, body: 'not JSON' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  test.each([null, [], 'text', 42])('rejects a non-object JSON body: %j', async (body) => {
    vi.stubEnv('WORKER_SECRET', 'test-secret');
    const t = convexTest(schema, modules);
    const response = await t.fetch('/worker/claim', post(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'JSON body must be an object' });
  });

  test.each([
    { path: '/worker/claim', fields: ['workerId'] },
    { path: '/worker/heartbeat', fields: ['jobId', 'workerId'] },
    { path: '/worker/event', fields: ['jobId', 'workerId', 'level', 'message'] },
    { path: '/worker/stage', fields: ['jobId', 'workerId', 'stage'] },
    { path: '/worker/upload-url', fields: ['jobId', 'workerId'] },
    { path: '/worker/deliver', fields: ['jobId', 'workerId'] },
    { path: '/worker/fail', fields: ['jobId', 'workerId', 'error'] },
  ])('$path requires its string fields', async ({ path, fields }) => {
    vi.stubEnv('WORKER_SECRET', 'test-secret');
    const t = convexTest(schema, modules);
    for (const field of fields) {
      for (const value of [undefined, null, 42, '']) {
        const body = { ...Object.fromEntries(fields.map((key) => [key, 'value'])), [field]: value };
        const response = await t.fetch(path, post(body));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: `${field} is required and must be a non-empty string` });
      }
    }
  });

  test('logs unexpected errors and hides their details', async () => {
    vi.stubEnv('WORKER_SECRET', 'test-secret');
    const t = convexTest(schema, modules);
    const error = new Error('Digest unavailable');
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await t.fetch('/worker/claim', post({ workerId }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal error' });
    expect(log).toHaveBeenCalledWith(error);
  });
});

describe('POST /worker/claim', () => {
  test('returns 204 with an empty body when the queue is empty', async () => {
    vi.stubEnv('WORKER_SECRET', 'test-secret');
    const t = convexTest(schema, modules);
    const response = await t.fetch('/worker/claim', post({ workerId }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  test.each([undefined, 60])('claims a queued job with leaseSeconds %s', async (leaseSeconds) => {
    const { t, jobId } = await setup();
    const response = await t.fetch('/worker/claim', post({ workerId, leaseSeconds }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toMatchObject({
      jobId,
      machine: { slug: 'new-machine', name: 'New machine', kind: 'instrument' },
      videoUrl: expect.any(String),
      leaseSeconds: leaseSeconds ?? 300,
    });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      status: 'running', workerId, leaseSeconds: leaseSeconds ?? 300,
    });
  });

  test('maps other ConvexErrors to 400', async () => {
    const { t, jobId } = await setup();
    const response = await t.fetch('/worker/claim', post({ workerId, leaseSeconds: 0 }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Lease length must be positive' });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status: 'queued' });
  });
});

describe('POST /worker/heartbeat', () => {
  test('returns the running status for the worker holding the lease', async () => {
    const { t, jobId } = await setup({ claim: true });
    const response = await t.fetch('/worker/heartbeat', post({ jobId, workerId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'running' });
  });

  test('returns the cancelled status to the worker', async () => {
    const { t, author, jobId } = await setup({ claim: true });
    await author.mutation(api.draftJobs.cancel, { jobId });
    const response = await t.fetch('/worker/heartbeat', post({ jobId, workerId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'cancelled' });
  });

  test('returns 409 when another worker holds the lease', async () => {
    const { t, jobId } = await setup({ claim: true });
    const response = await t.fetch('/worker/heartbeat', post({ jobId, workerId: 'wrong-worker' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Lease lost' });
  });
});

describe('POST /worker/event', () => {
  test('appends an event visible to the author', async () => {
    const { t, author, jobId } = await setup({ claim: true });
    const response = await t.fetch('/worker/event', post({ jobId, workerId, level: 'info', message: 'Started' }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(await author.query(api.draftJobs.events, { jobId })).toEqual([
      { at: expect.any(Number), level: 'info', message: 'Started' },
    ]);
  });
});

describe('POST /worker/stage', () => {
  test('updates the stage and preserves the session when omitted on a later request', async () => {
    const { t, author, jobId } = await setup({ claim: true });
    const response = await t.fetch('/worker/stage', post({
      jobId, workerId, stage: 'modeling', codexSessionId: 'session-1',
    }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(await author.query(api.draftJobs.get, { jobId })).toMatchObject({ stage: 'modeling' });
    const next = await t.fetch('/worker/stage', post({ jobId, workerId, stage: 'validating' }));
    expect(next.status).toBe(204);
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
      stage: 'validating', codexSessionId: 'session-1',
    });
  });
});

describe('POST /worker/upload-url', () => {
  test('returns a storage upload URL for the worker holding the lease', async () => {
    const { t, jobId } = await setup({ claim: true });
    const response = await t.fetch('/worker/upload-url', post({ jobId, workerId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: expect.any(String) });
  });

  test('rejects a worker that does not hold the lease', async () => {
    const { t, jobId } = await setup({ claim: true });
    const response = await t.fetch('/worker/upload-url', post({ jobId, workerId: 'wrong-worker' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Lease lost' });
  });

  test('rejects a missing job', async () => {
    const { t, jobId } = await setup({ claim: true });
    await t.run((ctx) => ctx.db.delete(jobId));
    const response = await t.fetch('/worker/upload-url', post({ jobId, workerId }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Job not found' });
  });
});

describe('POST /worker/deliver', () => {
  test.each([undefined, null, [], 'invalid'])('requires a procedure object: %j', async (procedure) => {
    const { t, jobId } = await setup({ claim: true });
    const response = await t.fetch('/worker/deliver', post({
      jobId, workerId, modelChanged: true, procedure, report: {},
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'procedure is required and must be an object' });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status: 'running' });
  });

  test('delivers a new machine and procedure and finishes the job', async () => {
    const { t, jobId, title } = await setup({ claim: true });
    const modelFileId = await t.run((ctx) => ctx.storage.store(new Blob(['model'])));
    const sourceFileId = await t.run((ctx) => ctx.storage.store(new Blob(['source'])));
    const content = emptyProcedureContent(title, templateDefinition);
    const response = await t.fetch('/worker/deliver', post({
      jobId, workerId, modelChanged: true,
      model: { modelFileId, sourceFileId, definition: templateDefinition },
      procedure: { content }, mediaFileIds: [], sourceContentHash: 'source-hash', report: { summary: 'Done' },
    }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ procedureVersionId: expect.any(String), machineVersionId: expect.any(String) });
    const job = await t.run((ctx) => ctx.db.get(jobId));
    expect(job).toMatchObject({
      status: 'done', stage: 'done',
      producedProcedureVersionId: result.procedureVersionId,
      producedMachineVersionId: result.machineVersionId,
    });
    expect(await t.run((ctx) => ctx.db.get(job!.producedProcedureVersionId!))).toMatchObject({ content });
    expect(await t.run((ctx) => ctx.db.get(job!.producedMachineVersionId!))).toMatchObject({
      modelFileId, sourceFileId, definition: templateDefinition,
    });
  });
});

describe('POST /worker/fail', () => {
  test('marks the job failed and records the error', async () => {
    const { t, author, jobId } = await setup({ claim: true });
    const error = 'Model generation failed';
    const response = await t.fetch('/worker/fail', post({ jobId, workerId, error }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(await author.query(api.draftJobs.get, { jobId })).toMatchObject({ status: 'failed', lastError: error });
    expect(await author.query(api.draftJobs.events, { jobId })).toEqual([
      { at: expect.any(Number), level: 'error', message: error },
    ]);
  });
});

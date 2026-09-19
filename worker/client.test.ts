import { describe, expect, it, vi } from 'vitest';
import { createWorkerClient, LeaseLostError, WorkerAuthError, WorkerRequestError } from './client.js';
import type { ClaimedJob, DeliverPayload, WorkerClient } from './types.js';

const job: ClaimedJob = {
  jobId: 'job-1',
  kind: 'revise',
  stage: 'queued',
  attempts: 2,
  workspaceKey: 'workspace-1',
  codexSessionId: 'session-1',
  machine: {
    slug: 'machine',
    name: 'Machine',
    kind: 'instrument',
    machineId: 'machine-1',
    current: {
      machineVersionId: 'machine-version-1',
      version: 1,
      definition: { parts: [] },
      modelUrl: 'https://storage.example/model',
      sourceUrl: 'https://storage.example/source',
    },
  },
  procedureSlug: 'clean',
  title: 'Clean the machine',
  brief: 'Show how to clean the machine.',
  instruction: 'Update the first step.',
  videoUrl: 'https://storage.example/video',
  target: {
    procedureVersionId: 'procedure-version-1',
    machineVersionId: 'machine-version-1',
    content: { steps: [] },
    definition: { parts: [] },
    contentHash: 'content-hash',
    modelUrl: 'https://storage.example/model',
  },
  approvedProcedures: [{ slug: 'start', content: { steps: [] } }],
  leaseSeconds: 90,
};

const delivery: DeliverPayload = {
  modelChanged: true,
  model: { modelFileId: 'model-file', sourceFileId: 'source-file', definition: { parts: [] } },
  procedure: { content: { steps: [] } },
  mediaFileIds: ['media-file'],
  sourceContentHash: 'content-hash',
  report: { valid: true },
};

const delivered = { procedureVersionId: 'procedure-version-2', machineVersionId: 'machine-version-2' };
const workerId = 'worker-1';
const secret = 'test-secret';

function makeClient(fetchRequest: typeof fetch, siteUrl = 'http://127.0.0.1:3211'): WorkerClient {
  return createWorkerClient({ siteUrl, secret, workerId, fetch: fetchRequest });
}

const requests: {
  name: string;
  path: string;
  body: object;
  result?: unknown;
  call: (client: WorkerClient) => Promise<unknown>;
}[] = [
  { name: 'claim', path: 'claim', body: { workerId }, result: job, call: client => client.claim() },
  {
    name: 'heartbeat', path: 'heartbeat', body: { jobId: job.jobId, workerId },
    result: { status: 'running' }, call: client => client.heartbeat(job.jobId),
  },
  ...(['info', 'warn', 'error'] as const).map(level => ({
    name: `event ${level}`, path: 'event', body: { jobId: job.jobId, workerId, level, message: 'Progress' },
    call: (client: WorkerClient) => client.event(job.jobId, level, 'Progress'),
  })),
  {
    name: 'stage', path: 'stage', body: { jobId: job.jobId, workerId, stage: 'building' },
    call: client => client.stage(job.jobId, 'building'),
  },
  {
    name: 'stage with session', path: 'stage',
    body: { jobId: job.jobId, workerId, stage: 'building', codexSessionId: 'session-2' },
    call: client => client.stage(job.jobId, 'building', 'session-2'),
  },
  {
    name: 'deliver', path: 'deliver', body: { jobId: job.jobId, workerId, ...delivery }, result: delivered,
    call: client => client.deliver(job.jobId, delivery),
  },
  {
    name: 'deliver without optional fields', path: 'deliver',
    body: { jobId: job.jobId, workerId, modelChanged: false, procedure: { content: null }, report: null },
    result: delivered,
    call: client => client.deliver(job.jobId, { modelChanged: false, procedure: { content: null }, report: null }),
  },
  {
    name: 'fail', path: 'fail', body: { jobId: job.jobId, workerId, error: 'Build failed' },
    call: client => client.fail(job.jobId, 'Build failed'),
  },
];

describe('createWorkerClient', () => {
  it.each(requests)('sends the $name contract', async ({ path, body, result, call }) => {
    const fetchRequest = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe(`http://127.0.0.1:3211/worker/${path}`);
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Worker-Secret')).toBe(secret);
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(JSON.parse(init?.body as string)).toEqual(body);
      return result === undefined ? new Response(null, { status: 204 }) : Response.json(result);
    });

    await expect(call(makeClient(fetchRequest))).resolves.toEqual(result);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    'http://127.0.0.1:3211',
    'http://127.0.0.1:3211/',
    'https://example.convex.site/',
    'https://example.convex.site///',
    'https://example.test/backend/',
  ])('joins worker paths onto %s and returns null for an idle claim', async siteUrl => {
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(makeClient(fetchRequest, siteUrl).claim()).resolves.toBeNull();
    expect(fetchRequest.mock.calls[0][0]).toBe(`${siteUrl.replace(/\/+$/, '')}/worker/claim`);
  });

  it('returns a cancelled heartbeat response', async () => {
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'cancelled' }));
    await expect(makeClient(fetchRequest).heartbeat(job.jobId)).resolves.toEqual({ status: 'cancelled' });
  });

  it('uploads only the supplied byte view with the content type and returns its storage ID', async () => {
    const bytes = new Uint8Array([99, 0, 1, 255, 99]).subarray(1, 4);
    const url = 'https://storage.example/upload?token=signed';
    const fetchRequest = vi.fn<typeof fetch>(async (input, init) => {
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe('POST');
      expect(headers.get('X-Worker-Secret')).toBe(secret);
      if (input === 'http://127.0.0.1:3211/worker/upload-url') {
        expect(headers.get('Content-Type')).toBe('application/json');
        expect(JSON.parse(init?.body as string)).toEqual({ jobId: job.jobId, workerId });
        return Response.json({ url });
      }
      expect(input).toBe(url);
      expect(headers.get('Content-Type')).toBe('model/gltf-binary');
      expect(init?.body).toBeInstanceOf(Uint8Array);
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(bytes);
      return Response.json({ storageId: 'storage-1' });
    });

    await expect(makeClient(fetchRequest).uploadFile(job.jobId, bytes, 'model/gltf-binary'))
      .resolves.toBe('storage-1');
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(fetchRequest.mock.calls.map(([input]) => input)).toEqual([
      'http://127.0.0.1:3211/worker/upload-url', url,
    ]);
  });

  describe.each([
    { status: 401, errorType: WorkerAuthError },
    { status: 409, errorType: LeaseLostError },
    { status: 500, errorType: WorkerRequestError },
  ])('HTTP $status', ({ status, errorType }) => {
    it.each([
      ...requests,
      {
        name: 'upload-url',
        call: (client: WorkerClient) => client.uploadFile(job.jobId, new Uint8Array([1]), 'image/png'),
      },
    ])('rejects $name with the correct error', async ({ call }) => {
      const fetchRequest = vi.fn<typeof fetch>().mockImplementation(async () =>
        new Response('Backend error details', { status }));
      const error = await call(makeClient(fetchRequest)).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(errorType);
      expect(error).toHaveProperty('message', expect.stringContaining('Backend error details'));
      if (status === 500) {
        expect(error).toHaveProperty('status', 500);
        expect(error).toHaveProperty('body', 'Backend error details');
      }
      expect(fetchRequest).toHaveBeenCalledTimes(1);
    });

    it('applies the same error handling to the byte upload', async () => {
      const fetchRequest = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ url: 'https://storage.example/upload' }))
        .mockResolvedValueOnce(new Response('Upload failed', { status }));
      const promise = makeClient(fetchRequest).uploadFile(job.jobId, new Uint8Array(), 'image/png');
      await expect(promise).rejects.toBeInstanceOf(errorType);
      if (status === 500) await expect(promise).rejects.toMatchObject({ status: 500, body: 'Upload failed' });
      expect(fetchRequest).toHaveBeenCalledTimes(2);
    });
  });
});

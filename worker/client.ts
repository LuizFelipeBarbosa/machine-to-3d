import type { ClaimedJob, WorkerClient } from './types.js';

export class WorkerAuthError extends Error {
  constructor(message = 'Worker authentication failed') {
    super(message);
    this.name = 'WorkerAuthError';
  }
}

export class LeaseLostError extends Error {
  constructor(message = 'Worker job lease lost') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

export class WorkerRequestError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Worker request failed (${status}): ${body}`);
    this.name = 'WorkerRequestError';
  }
}

export function createWorkerClient(options: {
  siteUrl: string;
  secret: string;
  workerId: string;
  fetch?: typeof fetch;
}): WorkerClient {
  const { secret, workerId, fetch: fetchRequest = globalThis.fetch } = options;
  const siteUrl = options.siteUrl.replace(/\/+$/, '');

  async function post(url: string, body: BodyInit, contentType: string): Promise<Response> {
    const response = await fetchRequest(url, {
      method: 'POST',
      headers: { 'X-Worker-Secret': secret, 'Content-Type': contentType },
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      if (response.status === 401) throw new WorkerAuthError(text);
      if (response.status === 409) throw new LeaseLostError(text);
      throw new WorkerRequestError(response.status, text);
    }
    return response;
  }

  function request(path: string, body: object): Promise<Response> {
    return post(`${siteUrl}/worker/${path}`, JSON.stringify({ ...body, workerId }), 'application/json');
  }

  return {
    async claim() {
      const response = await request('claim', {});
      return response.status === 204 ? null : await response.json() as ClaimedJob;
    },
    async heartbeat(jobId) {
      return (await request('heartbeat', { jobId })).json();
    },
    async event(jobId, level, message) {
      await request('event', { jobId, level, message });
    },
    async stage(jobId, stage, codexSessionId) {
      await request('stage', { jobId, stage, codexSessionId });
    },
    async uploadFile(jobId, bytes, contentType) {
      const { url } = await (await request('upload-url', { jobId })).json() as { url: string };
      // Copy the view so only its bytes are uploaded, including views backed by shared memory.
      const response = await post(url, new Uint8Array(bytes), contentType);
      const { storageId } = await response.json() as { storageId: string };
      return storageId;
    },
    async deliver(jobId, payload) {
      return (await request('deliver', { ...payload, jobId })).json();
    },
    async fail(jobId, error) {
      await request('fail', { jobId, error });
    },
  };
}

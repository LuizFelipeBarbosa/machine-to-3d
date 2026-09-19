import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseLostError, WorkerAuthError, WorkerRequestError } from './client.js';
import { runLoop } from './loop.js';
import type { ClaimedJob, WorkerClient } from './types.js';

const job: ClaimedJob = {
  jobId: 'job-1',
  kind: 'create',
  stage: 'queued',
  attempts: 1,
  workspaceKey: 'workspace-1',
  machine: { slug: 'machine', name: 'Machine', kind: 'instrument' },
  procedureSlug: 'clean',
  title: 'Clean the machine',
  brief: 'Show how to clean the machine.',
  approvedProcedures: [],
  leaseSeconds: 90,
};

function makeClient() {
  return {
    claim: vi.fn<WorkerClient['claim']>().mockResolvedValue(job),
    heartbeat: vi.fn<WorkerClient['heartbeat']>().mockResolvedValue({ status: 'running' }),
    event: vi.fn<WorkerClient['event']>().mockResolvedValue(undefined),
    stage: vi.fn<WorkerClient['stage']>().mockResolvedValue(undefined),
    uploadFile: vi.fn<WorkerClient['uploadFile']>().mockResolvedValue('storage-1'),
    deliver: vi.fn<WorkerClient['deliver']>().mockResolvedValue({
      procedureVersionId: 'procedure-version-1', machineVersionId: 'machine-version-1',
    }),
    fail: vi.fn<WorkerClient['fail']>().mockResolvedValue(undefined),
  } satisfies WorkerClient;
}

function stopAfterClaims(count: number) {
  let claims = 0;
  return () => claims++ >= count;
}

type RunJob = Parameters<typeof runLoop>[0]['runJob'];

describe('runLoop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([undefined, 250])('sleeps after an idle claim with pollMs %s', async pollMs => {
    const client = makeClient();
    client.claim.mockResolvedValue(null);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const runJob = vi.fn<RunJob>();
    await runLoop({ client, runJob, pollMs, sleep, shouldStop: stopAfterClaims(1) });
    expect(client.claim).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(pollMs ?? 15000);
    expect(runJob).not.toHaveBeenCalled();
    expect(client.heartbeat).not.toHaveBeenCalled();
  });

  it('runs jobs one at a time and claims again immediately without sleeping', async () => {
    const client = makeClient();
    const nextJob = { ...job, jobId: 'job-2' };
    client.claim.mockResolvedValueOnce(job).mockResolvedValueOnce(nextJob);
    const finished = Promise.withResolvers<void>();
    const runJob = vi.fn<RunJob>().mockImplementationOnce(() => finished.promise).mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const loop = runLoop({ client, runJob, sleep, shouldStop: stopAfterClaims(2) });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.claim).toHaveBeenCalledTimes(1);
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob.mock.calls[0][0]).toBe(job);
    expect(runJob.mock.calls[0][1].client).toBe(client);
    expect(runJob.mock.calls[0][1].signal.aborted).toBe(false);
    await runJob.mock.calls[0][1].log('warn', 'Check the model');
    expect(client.event).toHaveBeenCalledExactlyOnceWith(job.jobId, 'warn', 'Check the model');

    finished.resolve();
    await loop;
    expect(client.claim).toHaveBeenCalledTimes(2);
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(runJob.mock.calls[1][0]).toBe(nextJob);
    expect(sleep).not.toHaveBeenCalled();
    expect(client.fail).not.toHaveBeenCalled();
    expect(client.deliver).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([new Error('Build failed'), 'Build failed'])('reports a job failure and continues: %s', async error => {
    const client = makeClient();
    const runJob = vi.fn<RunJob>().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await runLoop({ client, runJob, sleep, shouldStop: stopAfterClaims(2) });
    expect(client.fail).toHaveBeenCalledExactlyOnceWith(job.jobId, 'Build failed');
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('swallows and reports failure-reporting errors before continuing', async () => {
    const client = makeClient();
    const failError = new WorkerRequestError(500, 'Unavailable');
    client.fail.mockRejectedValue(failError);
    const runJob = vi.fn<RunJob>().mockRejectedValueOnce(new Error('Build failed')).mockResolvedValue(undefined);
    const onError = vi.fn();
    await runLoop({ client, runJob, onError, shouldStop: stopAfterClaims(2) });
    expect(client.fail).toHaveBeenCalledExactlyOnceWith(job.jobId, 'Build failed');
    expect(onError).toHaveBeenCalledExactlyOnceWith(failError);
    expect(client.claim).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not report a lease loss thrown by the job as a job failure', async () => {
    const client = makeClient();
    const runJob = vi.fn<RunJob>().mockRejectedValue(new LeaseLostError());
    await runLoop({ client, runJob, shouldStop: stopAfterClaims(1) });
    expect(client.fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 100])('heartbeats every heartbeatMs %s and clears the timer on success', async heartbeatMs => {
    const client = makeClient();
    const finished = Promise.withResolvers<void>();
    const runJob = vi.fn<RunJob>().mockImplementation(() => finished.promise);
    const loop = runLoop({ client, runJob, heartbeatMs, shouldStop: stopAfterClaims(1) });
    const interval = heartbeatMs ?? 30000;
    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(client.heartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.heartbeat).toHaveBeenCalledExactlyOnceWith(job.jobId);
    expect(runJob.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(interval);
    expect(client.heartbeat).toHaveBeenCalledTimes(2);
    finished.resolve();
    await loop;
    await vi.advanceTimersByTimeAsync(interval);
    expect(client.heartbeat).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cancelled', 'lease lost'])('aborts the signal when the heartbeat reports %s', async outcome => {
    const client = makeClient();
    if (outcome === 'cancelled') client.heartbeat.mockResolvedValue({ status: 'cancelled' });
    else client.heartbeat.mockRejectedValue(new LeaseLostError());
    const runJob = vi.fn<RunJob>().mockImplementation((_job, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Job aborted')), { once: true });
    }));
    const loop = runLoop({ client, runJob, heartbeatMs: 100, shouldStop: stopAfterClaims(1) });
    await vi.advanceTimersByTimeAsync(100);
    await loop;
    expect(runJob.mock.calls[0][1].signal.aborted).toBe(true);
    expect(client.heartbeat).toHaveBeenCalledExactlyOnceWith(job.jobId);
    if (outcome === 'cancelled') expect(client.fail).toHaveBeenCalledExactlyOnceWith(job.jobId, 'Job aborted');
    else expect(client.fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a pending heartbeat lease decision before reporting job failure', async () => {
    const client = makeClient();
    const heartbeat = Promise.withResolvers<{ status: 'running' }>();
    client.heartbeat.mockReturnValue(heartbeat.promise);
    const finished = Promise.withResolvers<void>();
    const runJob = vi.fn<RunJob>().mockImplementation(() => finished.promise);
    const loop = runLoop({ client, runJob, heartbeatMs: 100, shouldStop: stopAfterClaims(1) });
    await vi.advanceTimersByTimeAsync(300);
    expect(client.heartbeat).toHaveBeenCalledTimes(1);
    finished.reject(new Error('Build failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    heartbeat.reject(new LeaseLostError());
    await loop;
    expect(runJob.mock.calls[0][1].signal.aborted).toBe(true);
    expect(client.fail).not.toHaveBeenCalled();
  });

  it('reports other heartbeat errors without aborting or stopping the heartbeat timer', async () => {
    const client = makeClient();
    const error = new WorkerRequestError(500, 'Unavailable');
    client.heartbeat.mockRejectedValueOnce(error);
    const finished = Promise.withResolvers<void>();
    const runJob = vi.fn<RunJob>().mockImplementation(() => finished.promise);
    const onError = vi.fn();
    const loop = runLoop({ client, runJob, heartbeatMs: 100, onError, shouldStop: stopAfterClaims(1) });
    await vi.advanceTimersByTimeAsync(200);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(client.heartbeat).toHaveBeenCalledTimes(2);
    expect(runJob.mock.calls[0][1].signal.aborted).toBe(false);
    finished.resolve();
    await loop;
    expect(client.fail).not.toHaveBeenCalled();
  });

  it('stops before making any claim when shouldStop is true', async () => {
    const client = makeClient();
    const runJob = vi.fn<RunJob>();
    const sleep = vi.fn();
    await runLoop({ client, runJob, sleep, shouldStop: () => true });
    expect(client.claim).not.toHaveBeenCalled();
    expect(runJob).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('checks shouldStop again after an idle sleep', async () => {
    const client = makeClient();
    client.claim.mockResolvedValue(null);
    let stopped = false;
    const sleep = vi.fn(async () => { stopped = true; });
    await runLoop({ client, runJob: vi.fn(), sleep, shouldStop: () => stopped });
    expect(client.claim).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(15000);
  });

  it('propagates claim errors to the caller', async () => {
    const client = makeClient();
    const error = new WorkerAuthError();
    client.claim.mockRejectedValue(error);
    await expect(runLoop({ client, runJob: vi.fn() })).rejects.toBe(error);
    expect(client.fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

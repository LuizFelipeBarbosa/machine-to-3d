import { describe, expect, it, vi } from 'vitest';
import { withStdoutLogging } from './main.js';
import type { ClaimedJob, DeliverPayload, WorkerClient } from './types.js';

const job: ClaimedJob = {
  jobId: 'job-1',
  kind: 'create',
  stage: 'queued',
  attempts: 2,
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

describe('withStdoutLogging', () => {
  it.each(['create', 'revise'] as const)('logs a claimed %s job and returns it unchanged', async kind => {
    const client = makeClient();
    const claimed = { ...job, kind };
    client.claim.mockResolvedValue(claimed);
    const logLine = vi.fn();
    const wrapped = withStdoutLogging(client, logLine);

    expect(await wrapped.claim()).toBe(claimed);
    expect(client.claim).toHaveBeenCalledExactlyOnceWith();
    expect(logLine).toHaveBeenCalledExactlyOnceWith('info', `claimed job job-1 (${kind} machine/clean, attempt 2)`);
  });

  it('returns null without logging when no job is claimed', async () => {
    const client = makeClient();
    client.claim.mockResolvedValue(null);
    const logLine = vi.fn();
    const wrapped = withStdoutLogging(client, logLine);

    expect(await wrapped.claim()).toBeNull();
    expect(client.claim).toHaveBeenCalledExactlyOnceWith();
    expect(logLine).not.toHaveBeenCalled();
  });

  it.each([undefined, 'session-1'])('logs and forwards a stage with session %s', async session => {
    const client = makeClient();
    const logLine = vi.fn();
    const wrapped = withStdoutLogging(client, logLine);

    expect(await wrapped.stage(job.jobId, 'modeling', session)).toBeUndefined();
    expect(client.stage).toHaveBeenCalledExactlyOnceWith(job.jobId, 'modeling', session);
    expect(logLine).toHaveBeenCalledExactlyOnceWith('info',
      `[job-1] stage → modeling${session ? ` session ${session}` : ''}`);
  });

  it.each(['info', 'warn', 'error'] as const)('logs and forwards an %s event', async level => {
    const client = makeClient();
    const logLine = vi.fn();
    const wrapped = withStdoutLogging(client, logLine);

    expect(await wrapped.event(job.jobId, level, 'Checking model')).toBeUndefined();
    expect(client.event).toHaveBeenCalledExactlyOnceWith(job.jobId, level, 'Checking model');
    expect(logLine).toHaveBeenCalledExactlyOnceWith(level, `[job-1] ${level}: Checking model`);
  });

  it('logs delivered version IDs and returns the delivery result unchanged', async () => {
    const client = makeClient();
    const result = { procedureVersionId: 'procedure-2', machineVersionId: 'machine-3' };
    client.deliver.mockResolvedValue(result);
    const logLine = vi.fn();
    const wrapped = withStdoutLogging(client, logLine);
    const payload: DeliverPayload = { modelChanged: false, procedure: { content: {} }, report: {} };

    expect(await wrapped.deliver(job.jobId, payload)).toBe(result);
    expect(client.deliver).toHaveBeenCalledExactlyOnceWith(job.jobId, payload);
    expect(logLine).toHaveBeenCalledExactlyOnceWith('info',
      '[job-1] delivered: procedure procedure-2, machine version machine-3');
  });

  it('logs and forwards failure details', async () => {
    const client = makeClient();
    const logLine = vi.fn();
    const wrapped = withStdoutLogging(client, logLine);

    expect(await wrapped.fail(job.jobId, 'Build failed')).toBeUndefined();
    expect(client.fail).toHaveBeenCalledExactlyOnceWith(job.jobId, 'Build failed');
    expect(logLine).toHaveBeenCalledExactlyOnceWith('error', '[job-1] failed: Build failed');
  });

  it('forwards heartbeats and uploads without logging', async () => {
    const client = makeClient();
    const heartbeat = { status: 'cancelled' } as const;
    client.heartbeat.mockResolvedValue(heartbeat);
    const logLine = vi.fn();
    const wrapped = withStdoutLogging(client, logLine);
    const bytes = new Uint8Array([1, 2, 3]);

    expect(await wrapped.heartbeat(job.jobId)).toBe(heartbeat);
    expect(client.heartbeat).toHaveBeenCalledExactlyOnceWith(job.jobId);
    expect(await wrapped.uploadFile(job.jobId, bytes, 'image/png')).toBe('storage-1');
    expect(client.uploadFile).toHaveBeenCalledExactlyOnceWith(job.jobId, bytes, 'image/png');
    expect(logLine).not.toHaveBeenCalled();
  });

  it('propagates rejected claims and deliveries without logging success', async () => {
    const client = makeClient();
    const error = new Error('Lease lost');
    client.claim.mockRejectedValue(error);
    client.deliver.mockRejectedValue(error);
    const logLine = vi.fn();
    const wrapped = withStdoutLogging(client, logLine);

    await expect(wrapped.claim()).rejects.toBe(error);
    await expect(wrapped.deliver(job.jobId, {
      modelChanged: false, procedure: { content: {} }, report: {},
    })).rejects.toBe(error);
    expect(logLine).not.toHaveBeenCalled();
  });
});

import { LeaseLostError } from './client.js';
import type { ClaimedJob, EventLevel, WorkerClient } from './types.js';

type LoopOptions = {
  client: WorkerClient;
  runJob: (job: ClaimedJob, context: {
    client: WorkerClient;
    log: (level: EventLevel, message: string) => Promise<void>;
    signal: AbortSignal;
  }) => Promise<void>;
  pollMs?: number;
  heartbeatMs?: number;
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  onError?: (error: unknown) => void;
};

export async function runLoop(options: LoopOptions): Promise<void> {
  const { client, pollMs = 15000, shouldStop = () => false, sleep = delay } = options;
  while (!shouldStop()) {
    const job = await client.claim();
    if (job === null) {
      await sleep(pollMs);
      continue;
    }
    await runClaimedJob(job, options);
  }
}

async function runClaimedJob(job: ClaimedJob, options: LoopOptions): Promise<void> {
  const { client, runJob, heartbeatMs = 30000, onError } = options;
  const controller = new AbortController();
  let leaseLost = false;
  let heartbeat: Promise<void> | undefined;

  async function sendHeartbeat(): Promise<void> {
    try {
      const result = await client.heartbeat(job.jobId);
      if (result.status === 'cancelled') controller.abort();
    } catch (error) {
      if (error instanceof LeaseLostError) {
        leaseLost = true;
        controller.abort(error);
      } else {
        onError?.(error);
      }
    }
  }

  const timer = setInterval(() => {
    if (heartbeat || controller.signal.aborted) return;
    heartbeat = sendHeartbeat().finally(() => { heartbeat = undefined; });
  }, heartbeatMs);

  try {
    try {
      await runJob(job, {
        client,
        log: (level, message) => client.event(job.jobId, level, message),
        signal: controller.signal,
      });
    } finally {
      clearInterval(timer);
      // Settle the last heartbeat before deciding whether this worker can report failure.
      await heartbeat;
    }
  } catch (error) {
    if (leaseLost || error instanceof LeaseLostError) return;
    try {
      await client.fail(job.jobId, error instanceof Error ? error.message : String(error));
    } catch (failError) {
      onError?.(failError);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

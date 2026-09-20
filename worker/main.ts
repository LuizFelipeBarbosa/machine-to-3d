#!/usr/bin/env node
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createWorkerClient } from './client.js';
import { runLoop } from './loop.js';
import { runJob } from './pipeline.js';
import type { WorkerClient } from './types.js';

export function withStdoutLogging(client: WorkerClient, logLine: (level: string, message: string) => void): WorkerClient {
  return {
    async claim() {
      const job = await client.claim();
      if (job) {
        logLine('info', `claimed job ${job.jobId} (${job.kind} ${job.machine.slug}/${job.procedureSlug}, attempt ${job.attempts})`);
      }
      return job;
    },
    heartbeat(jobId) {
      return client.heartbeat(jobId);
    },
    event(jobId, level, message) {
      logLine(level, `[${jobId}] ${level}: ${message}`);
      return client.event(jobId, level, message);
    },
    stage(jobId, stage, codexSessionId) {
      logLine('info', `[${jobId}] stage → ${stage}${codexSessionId === undefined ? '' : ` session ${codexSessionId}`}`);
      return client.stage(jobId, stage, codexSessionId);
    },
    uploadFile(jobId, bytes, contentType) {
      return client.uploadFile(jobId, bytes, contentType);
    },
    async deliver(jobId, payload) {
      const result = await client.deliver(jobId, payload);
      logLine('info', `[${jobId}] delivered: procedure ${result.procedureVersionId}, machine version ${result.machineVersionId}`);
      return result;
    },
    fail(jobId, error) {
      logLine('error', `[${jobId}] failed: ${error}`);
      return client.fail(jobId, error);
    },
  };
}

function logLine(level: string, message: string): void {
  console.log(`${new Date().toISOString()} [${level}] ${message}`);
}

async function main(): Promise<void> {
  const secret = process.env.WORKER_SECRET;
  if (!secret) {
    console.error('WORKER_SECRET is required');
    process.exit(1);
  }
  const siteUrl = process.env.CONVEX_SITE_URL;
  if (!siteUrl) {
    console.error('CONVEX_SITE_URL is required');
    process.exit(1);
  }

  const home = process.env.WORKER_HOME ?? join(homedir(), '.instrument-trainer');
  const command = process.env.WORKER_CODEX_CMD;
  const configuredProvider = process.env.WORKER_CODEX_PROVIDER;
  const provider: 'cliproxyapi' | 'default' = configuredProvider === 'default'
    || configuredProvider === 'cliproxyapi' ? configuredProvider : 'cliproxyapi';
  const pollMs = Number.parseInt(process.env.WORKER_POLL_MS ?? '15000', 10);
  const workerId = `${hostname()}-${process.pid}`;
  const client = withStdoutLogging(createWorkerClient({ siteUrl, secret, workerId }), logLine);
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

  logLine('info', `worker ${workerId} starting; repoRoot=${repoRoot}; home=${home}`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopping = true;
      logLine('info', `shutdown requested (${signal})`);
    });
  }

  let loggedIdle = false;
  await runLoop({
    client,
    runJob: (job, ctx) => runJob(job, ctx, {
      home, repoRoot, codex: { command, provider },
    }),
    pollMs,
    sleep: ms => {
      if (!loggedIdle) {
        logLine('info', `no queued jobs; polling every ${pollMs} ms`);
        loggedIdle = true;
      }
      return delay(ms);
    },
    shouldStop: () => stopping,
    onError: error => logLine('error', `job failed: ${error instanceof Error ? error.message : String(error)}`),
  });
  logLine('info', 'worker stopped');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type CodexRunOptions = {
  workspace: string;
  prompt: string;
  images?: string[];
  resumeSessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  outputSchemaPath?: string;
  networkAccess?: boolean;
  provider?: 'cliproxyapi' | 'default';
  model?: string;
  effort?: 'medium' | 'high' | 'xhigh';
  command?: string;
  commandArgsPrefix?: string[];
  env?: Record<string, string>;
  onEvent?: (event: CodexEvent) => void;
};

export type CodexEvent = { type: string; text?: string; raw: unknown };

export type CodexRunResult = {
  sessionId: string | null;
  finalMessage: string;
  report: unknown | null;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
};

function buildArgs(options: CodexRunOptions, outputPath: string): string[] {
  const args = ['exec'];
  if (options.resumeSessionId !== undefined) args.push('resume', options.resumeSessionId);
  args.push('--json', '-C', options.workspace, '--sandbox', 'workspace-write',
    '--skip-git-repo-check', '-o', outputPath);
  if (options.outputSchemaPath) args.push('--output-schema', options.outputSchemaPath);
  if (options.resumeSessionId === undefined) {
    for (const image of options.images ?? []) args.push('-i', image);
  }
  if (options.networkAccess !== false) {
    args.push('-c', 'sandbox_workspace_write.network_access=true');
  }
  args.push('-c', `model_reasoning_effort="${options.effort ?? 'high'}"`);
  if (options.model) args.push('-m', options.model);
  if ((options.provider ?? 'cliproxyapi') === 'cliproxyapi') {
    args.push('-c', 'model_provider="cliproxyapi"');
  }
  args.push('-');
  return [...options.commandArgsPrefix ?? [], ...args];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function findSessionId(raw: unknown): string | null {
  const pending = [raw];
  while (pending.length > 0) {
    const value = pending.pop();
    const record = asRecord(value);
    if (record) {
      for (const key of ['thread_id', 'session_id', 'conversation_id']) {
        if (typeof record[key] === 'string' && record[key]) return record[key];
      }
      if ((record.type === 'thread.started' || record.type === 'session.created')
        && typeof record.id === 'string' && record.id) return record.id;
    }
    // Reverse the stack entries to visit nested values in their original order.
    const children = Array.isArray(value) ? value : record ? Object.values(record) : [];
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  return null;
}

function parseEvent(line: string): CodexEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { type: 'stderr-ish', text: line, raw: line };
  }
  const event = asRecord(raw);
  if (!event) return { type: 'unknown', raw };
  const item = asRecord(event.item) ?? event;
  const type = typeof event.type === 'string' ? event.type : 'unknown';
  if (item.type === 'agent_message' && typeof item.text === 'string') {
    return { type: 'agent_message', text: item.text, raw };
  }
  if (item.type === 'command_execution' && typeof item.command === 'string') {
    return { type: 'command_execution', text: item.command, raw };
  }
  const error = asRecord(event.error);
  const message = error?.message ?? event.message ?? item.message ?? event.error;
  if (typeof message === 'string') return { type, text: message, raw };
  return { type, raw };
}

function parseReport(message: string): unknown | null {
  const text = message.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\s*```$/i, '$1');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function runAttempt(options: CodexRunOptions): Promise<{
  result: CodexRunResult;
  output: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'worker-codex-'));
  try {
    const outputPath = join(directory, 'final-message.txt');
    const args = buildArgs(options, outputPath);
    const startedAt = Date.now();
    const child = spawn(options.command ?? process.env.WORKER_CODEX_CMD ?? 'codex', args, {
      cwd: options.workspace,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let sessionId: string | null = null;
    let lastAgentMessage = '';
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let durationMs = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    function terminate(): void {
      if (killTimer !== undefined) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    }
    function onAbort(): void {
      aborted = true;
      terminate();
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? 45 * 60 * 1000);

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      lines.on('line', line => {
        const event = parseEvent(line);
        sessionId ??= findSessionId(event.raw);
        if (event.type === 'agent_message') lastAgentMessage = event.text ?? '';
        try {
          options.onEvent?.(event);
        } catch (error) {
          // Surface callback errors through the promise, never the stream emitter.
          failure = error instanceof Error ? error : new Error(String(error));
          child.kill('SIGKILL');
        }
      });
      child.on('error', error => { failure = error; });
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        // An early CLI failure can close stdin before a long prompt is written.
        if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
          failure = error;
          child.kill('SIGKILL');
        }
      });
      child.once('exit', () => {
        durationMs = Date.now() - startedAt;
        clearTimeout(timeout);
        clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', onAbort);
      });
      child.once('close', code => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', onAbort);
        lines.close();
        if (failure) reject(failure);
        else resolve(aborted && code === 0 ? 1 : code ?? 1); // Signal termination has no numeric exit code.
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      child.stdin.end(options.prompt);
    });

    let finalMessage: string;
    try {
      finalMessage = await readFile(outputPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      finalMessage = '';
    }
    if (!finalMessage.trim()) finalMessage = lastAgentMessage;
    return {
      result: { sessionId, finalMessage, report: parseReport(finalMessage),
        exitCode, timedOut, aborted, durationMs },
      output: `${stdout}\n${stderr}`,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runCodex(options: CodexRunOptions): Promise<CodexRunResult> {
  return (await runAttempt(options)).result;
}

export async function runCodexWithFallback(options: CodexRunOptions): Promise<CodexRunResult> {
  const { result, output } = await runAttempt(options);
  if (result.exitCode !== 0 && result.durationMs <= 60_000
    && /model_provider|cliproxyapi|ECONNREFUSED|401/i.test(output)) {
    options.onEvent?.({
      type: 'provider-fallback',
      text: 'Provider failed within 60 seconds; retrying with the default provider.',
      raw: null,
    });
    return runCodex({ ...options, provider: 'default' });
  }
  return result;
}

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCodex, runCodexWithFallback } from './codex.js';
import type { CodexEvent, CodexRunOptions, CodexRunResult } from './codex.js';

const fixturePath = resolve('worker/fixtures/fake-codex.mjs');
const baseOptions: CodexRunOptions = {
  workspace: process.cwd(),
  prompt: 'Build a machine model.',
  command: process.execPath,
  commandArgsPrefix: [fixturePath],
  env: { FAKE_CODEX_MODE: '', FAKE_CODEX_SESSION_EVENT: '' },
};

type FixtureReport = { status: string; promptLength: number; resumed: boolean; argv: string[] };

function reportOf(result: CodexRunResult): FixtureReport {
  expect(result.exitCode).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(result.report).toMatchObject({ status: 'complete' });
  return result.report as FixtureReport;
}

describe('runCodex', () => {
  it('passes fresh-run arguments and parses the final file', async () => {
    const events: CodexEvent[] = [];
    const result = await runCodex({ ...baseOptions,
      images: ['/tmp/front view.png', '/tmp/back.png'],
      onEvent: event => events.push(event),
    });
    const report = reportOf(result);
    expect(report).toEqual({
      status: 'complete', promptLength: baseOptions.prompt.length, resumed: false,
      argv: ['exec', '--json', '-C', baseOptions.workspace, '--sandbox', 'workspace-write',
        '--skip-git-repo-check', '-o', expect.any(String),
        '-i', '/tmp/front view.png', '-i', '/tmp/back.png',
        '-c', 'sandbox_workspace_write.network_access=true',
        '-c', 'model_reasoning_effort="high"', '-c', 'model_provider="cliproxyapi"', '-'],
    });
    expect(JSON.parse(result.finalMessage)).toEqual(report);
    expect(result.sessionId).toBe('sess-123');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(events.map(event => event.type)).toEqual([
      'thread.started', 'agent_message', 'command_execution',
    ]);
    expect(events[1]).toMatchObject({ text: 'working on it', raw: { type: 'item.completed' } });
    expect(events[2].text).toBe('echo hi');
  });

  it('resumes a session without passing images', async () => {
    const report = reportOf(await runCodex({ ...baseOptions,
      resumeSessionId: 'previous-session', images: ['/tmp/ignored.png'],
    }));
    expect(report.resumed).toBe(true);
    expect(report.argv.slice(0, 3)).toEqual(['exec', 'resume', 'previous-session']);
    expect(report.argv).not.toContain('-i');
    expect(report.argv).not.toContain('/tmp/ignored.png');
  });

  it.each([
    { envelope: [{ nested: { session_id: 'nested-session' } }] },
    { conversation_id: 'nested-session' },
    { type: 'thread.started', id: 'nested-session' },
    { envelope: { type: 'session.created', id: 'nested-session' } },
  ])('captures session IDs across event shapes: %j', async event => {
    const result = await runCodex({ ...baseOptions,
      env: { FAKE_CODEX_SESSION_EVENT: JSON.stringify(event), FAKE_CODEX_MODE: 'mixed-events' },
    });
    expect(result.sessionId).toBe('nested-session');
  });

  it('honors provider, schema, model, effort and network options', async () => {
    const report = reportOf(await runCodex({ ...baseOptions,
      provider: 'default', outputSchemaPath: '/tmp/report schema.json',
      model: 'example-model', effort: 'xhigh', networkAccess: false,
    }));
    expect(report.argv).toEqual([
      'exec', '--json', '-C', baseOptions.workspace, '--sandbox', 'workspace-write',
      '--skip-git-repo-check', '-o', expect.any(String),
      '--output-schema', '/tmp/report schema.json',
      '-c', 'model_reasoning_effort="xhigh"', '-m', 'example-model', '-',
    ]);
  });

  it('sends a prompt larger than OS argument limits over stdin', async () => {
    const prompt = 'Long prompt with Unicode ☃\n'.repeat(100_000);
    const report = reportOf(await runCodex({ ...baseOptions, prompt }));
    expect(report.promptLength).toBe(prompt.length);
    expect(report.argv).not.toContain(prompt);
  });

  it('uses distinct output paths for independent runs', async () => {
    const first = reportOf(await runCodex(baseOptions));
    const second = reportOf(await runCodex(baseOptions));
    expect(first.argv[first.argv.indexOf('-o') + 1])
      .not.toBe(second.argv[second.argv.indexOf('-o') + 1]);
  });

  it.each(['missing-output', 'empty-output'])('falls back to the agent message for %s', async mode => {
    const result = await runCodex({ ...baseOptions, env: { FAKE_CODEX_MODE: mode } });
    expect(result.finalMessage).toBe('working on it');
    expect(result.report).toBeNull();
  });

  it('parses a Markdown-fenced final report', async () => {
    const result = await runCodex({ ...baseOptions, env: { FAKE_CODEX_MODE: 'fenced-output' } });
    expect(reportOf(result).promptLength).toBe(baseOptions.prompt.length);
    expect(result.finalMessage.startsWith('```json')).toBe(true);
  });

  it('tolerates malformed and unknown lines, preserves the first ID, and uses the last message', async () => {
    const events: CodexEvent[] = [];
    const result = await runCodex({ ...baseOptions,
      env: { FAKE_CODEX_MODE: 'mixed-events' }, onEvent: event => events.push(event),
    });
    expect(events.slice(3)).toEqual([
      { type: 'stderr-ish', text: 'not JSON', raw: 'not JSON' },
      { type: 'stderr-ish', text: '{malformed', raw: '{malformed' },
      { type: 'unknown', raw: null },
      { type: 'unknown', raw: { details: [{ session_id: 'later-session' }] } },
      { type: 'error', text: 'Example error', raw: { type: 'error', message: 'Example error' } },
      { type: 'agent_message', text: '{"last":true}',
        raw: { type: 'agent_message', text: '{"last":true}' } },
    ]);
    expect(result.sessionId).toBe('sess-123');
    expect(result.finalMessage).toBe('{"last":true}');
    expect(result.report).toEqual({ last: true });
  });

  it('kills a hung process at the wall-clock timeout', async () => {
    const result = await runCodex({ ...baseOptions,
      timeoutMs: 200, env: { FAKE_CODEX_MODE: 'hang' },
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(190);
    expect(result.durationMs).toBeLessThan(4_000);
  }, 5_000);

  it('rejects a spawn failure without unhandled stream errors', async () => {
    await expect(runCodex({ ...baseOptions, workspace: resolve('missing-codex-workspace') }))
      .rejects.toThrow();
  });

  it('escalates to SIGKILL after ten seconds when SIGTERM is ignored', async () => {
    const result = await runCodex({ ...baseOptions,
      timeoutMs: 500, env: { FAKE_CODEX_MODE: 'ignore-term' },
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(10_400);
    expect(result.durationMs).toBeLessThan(14_000);
  }, 15_000);

  it('rejects a callback error and terminates the child', async () => {
    await expect(runCodex({ ...baseOptions, env: { FAKE_CODEX_MODE: 'hang' },
      onEvent: () => { throw new Error('Callback failed'); },
    })).rejects.toThrow('Callback failed');
  });
});

describe('runCodexWithFallback', () => {
  it('retries provider failures once and emits the fallback before the retry events', async () => {
    const events: CodexEvent[] = [];
    const result = await runCodexWithFallback({ ...baseOptions,
      env: { FAKE_CODEX_MODE: 'fail-provider' }, onEvent: event => events.push(event),
    });
    const report = reportOf(result);
    expect(report.argv.some(arg => arg.includes('model_provider'))).toBe(false);
    expect(events.map(event => event.type)).toEqual([
      'thread.started', 'agent_message', 'command_execution', 'provider-fallback',
      'thread.started', 'agent_message', 'command_execution',
    ]);
    expect(events[3]).toEqual({ type: 'provider-fallback', text: expect.any(String), raw: null });
  });

  it('does not retry unrelated failures', async () => {
    const events: CodexEvent[] = [];
    const result = await runCodexWithFallback({ ...baseOptions,
      env: { FAKE_CODEX_MODE: 'fail-other' }, onEvent: event => events.push(event),
    });
    expect(result).toMatchObject({ exitCode: 1, timedOut: false,
      sessionId: 'sess-123', finalMessage: 'working on it', report: null });
    expect(events.map(event => event.type)).toEqual([
      'thread.started', 'agent_message', 'command_execution',
    ]);
  });

  it('matches provider diagnostics on stdout and stops after one failed retry', async () => {
    const events: CodexEvent[] = [];
    const result = await runCodexWithFallback({ ...baseOptions,
      env: { FAKE_CODEX_MODE: 'fail-always' }, onEvent: event => events.push(event),
    });
    expect(result.exitCode).toBe(1);
    expect(events.filter(event => event.type === 'provider-fallback')).toHaveLength(1);
    expect(events.filter(event => event.type === 'thread.started')).toHaveLength(2);
  });
});

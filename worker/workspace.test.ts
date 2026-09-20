import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { summarizeGlb } from '../scripts/lib/glb.js';
import { referencedClips, referencedNodes } from '../shared/machine.js';
import type { ClaimedJob } from './types.js';
import { prepareWorkspace, renderTemplate } from './workspace.js';

const repoRoot = process.cwd();
const definition = {
  formatVersion: 1,
  rootNode: 'TestMachine',
  parts: [
    { name: 'housing', label: 'Housing', blurb: 'Instrument housing.' },
    { name: 'lid', label: 'Lid', blurb: 'Access lid.' },
  ],
  presetViews: [],
  stateVars: [{
    name: 'lidOpen', label: 'Lid open', kind: 'toggle',
    effects: [{ type: 'rotate', node: 'lid', axis: 'x', angle: 1 }],
  }],
};

function createJob(): ClaimedJob {
  return {
    jobId: 'job-1',
    kind: 'create',
    stage: 'queued',
    attempts: 1,
    workspaceKey: 'machine-1',
    machine: { slug: 'test-machine', name: 'Test Machine', kind: 'instrument' },
    procedureSlug: 'clean',
    title: 'Clean the machine',
    brief: '',
    approvedProcedures: [],
    leaseSeconds: 90,
  };
}

describe('prepareWorkspace', () => {
  let home: string;
  let job: ClaimedJob;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'worker-workspace-'));
    job = createJob();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('prepares a new machine from the template with tooling and a rendered task', async () => {
    const result = await prepareWorkspace(job, { home, repoRoot });
    expect(result.dir).toBe(join(home, 'machines', job.workspaceKey));
    expect(result.mode).toBe('new-machine');
    for (const file of ['buildModel.ts', 'machine.json']) {
      expect(await readFile(join(result.dir, file), 'utf8'))
        .toBe(await readFile(join(repoRoot, 'worker/kit/template', file), 'utf8'));
    }
    expect(JSON.parse(await readFile(join(result.dir, 'package.json'), 'utf8'))).toEqual({
      name: 'machine-1-workspace',
      private: true,
      type: 'module',
      scripts: {
        export: `node --import tsx ${repoRoot}/scripts/export-model.ts buildModel.ts --out model.glb`,
        validate: `node --import tsx ${repoRoot}/worker/kit/validate.ts ${result.dir}`,
      },
    });
    const modules = join(result.dir, 'node_modules');
    expect((await lstat(modules)).isSymbolicLink()).toBe(true);
    expect(resolve(result.dir, await readlink(modules))).toBe(join(repoRoot, 'node_modules'));
    expect(await realpath(modules)).toBe(await realpath(join(repoRoot, 'node_modules')));
    expect(result.videoFile).toBeNull();
    expect(result.videoDir).toBe(join(result.dir, 'videos/clean'));
    expect(result.procedureFile).toBe(join(result.dir, 'procedures/clean.json'));
    for (const directory of ['procedures', 'references', 'videos/clean']) {
      expect((await lstat(join(result.dir, directory))).isDirectory()).toBe(true);
    }
    expect(result.taskPrompt).not.toContain('{{');
    expect(result.taskPrompt).toContain('# Mode — new-machine');
    expect(result.taskPrompt).toContain('(none)');
    expect(result.taskPrompt).toContain('(no video was provided)');
    expect(await readFile(join(result.dir, 'TASK.md'), 'utf8')).toBe(result.taskPrompt);
  });

  it('restores every file from an existing machine source bundle', async () => {
    job.machine.current = {
      machineVersionId: 'version-1', version: 1, definition,
      modelUrl: 'https://storage.example/model', sourceUrl: 'https://storage.example/source',
    };
    const source = {
      'buildModel.ts': '// Existing editable model\n',
      'machine.json': JSON.stringify(definition),
      'references/notes/source.md': 'Original source notes.',
    };
    const fetchRequest = vi.fn<typeof fetch>(async url => {
      expect(url).toBe(job.machine.current?.sourceUrl);
      return Response.json(source);
    });
    const result = await prepareWorkspace(job, { home, repoRoot, fetch: fetchRequest });
    expect(result.mode).toBe('existing-machine');
    for (const [file, content] of Object.entries(source)) {
      expect(await readFile(join(result.dir, file), 'utf8')).toBe(content);
    }
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });

  it('prepares a seeded machine without editable source and preserves its names', async () => {
    const seededDefinition = JSON.parse(await readFile(join(repoRoot, 'seed/rise-raman-sem/machine.json'), 'utf8'));
    const modelBytes = await readFile(join(repoRoot, 'seed/rise-raman-sem/model.glb'));
    job.machine.current = {
      machineVersionId: 'version-1', version: 1, definition: seededDefinition,
      modelUrl: 'https://storage.example/model',
    };
    const fetchRequest = vi.fn<typeof fetch>(async url => {
      expect(url).toBe(job.machine.current?.modelUrl);
      return new Response(modelBytes, { headers: { 'content-type': 'model/gltf-binary' } });
    });
    const result = await prepareWorkspace(job, { home, repoRoot, fetch: fetchRequest });
    expect(result.mode).toBe('existing-machine');
    expect(await readFile(join(result.dir, 'model.glb'))).toEqual(modelBytes);
    expect(JSON.parse(await readFile(join(result.dir, 'machine.json'), 'utf8'))).toEqual(seededDefinition);
    await expect(lstat(join(result.dir, 'buildModel.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    const reference = await readFile(join(result.dir, 'references/EXISTING.md'), 'utf8');
    const summary = summarizeGlb(modelBytes);
    expect(reference).toContain(seededDefinition.rootNode);
    for (const name of referencedNodes(seededDefinition)) expect(reference).toContain(name);
    for (const name of referencedClips(seededDefinition)) {
      const animation = summary.animations.find(candidate => candidate.name === name)!;
      expect(reference).toContain(`duration: ${animation.duration} seconds`);
      for (const node of animation.targetNodes) expect(reference).toContain(node);
    }
    expect(reference).toContain(`Bounding box: min ${JSON.stringify(summary.boundingBox!.min)}; max ${JSON.stringify(summary.boundingBox!.max)}`);
    expect(reference).toContain('no editable source');
    expect(reference).toContain('npm run export');
    expect(reference).toContain('buildModel.ts must be written from scratch');
  });

  it('keeps local model edits across jobs and derives mode from backend state', async () => {
    const first = await prepareWorkspace(job, { home, repoRoot });
    await writeFile(join(first.dir, 'buildModel.ts'), '// Hand-edited model');
    await writeFile(join(first.dir, 'machine.json'), '{"handEdited":true}');
    const second = await prepareWorkspace(job, { home, repoRoot });
    expect(second.mode).toBe('new-machine');
    expect(second.taskPrompt).toContain('# Mode — new-machine');
    expect(await readFile(join(second.dir, 'buildModel.ts'), 'utf8')).toBe('// Hand-edited model');
    expect(await readFile(join(second.dir, 'machine.json'), 'utf8')).toBe('{"handEdited":true}');

    job.machine.current = {
      machineVersionId: 'version-2', version: 2, definition,
      modelUrl: 'https://storage.example/model', sourceUrl: 'https://storage.example/source',
    };
    const fetchRequest = vi.fn<typeof fetch>();
    const third = await prepareWorkspace(job, { home, repoRoot, fetch: fetchRequest });
    expect(third.mode).toBe('existing-machine');
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(await readFile(join(second.dir, 'buildModel.ts'), 'utf8')).toBe('// Hand-edited model');
  });

  it('writes approved procedures only once', async () => {
    const content = { title: 'Start', steps: [] };
    job.approvedProcedures = [{ slug: 'start', content }];
    const first = await prepareWorkspace(job, { home, repoRoot });
    const file = join(first.dir, 'procedures/start.json');
    expect(await readFile(file, 'utf8')).toBe(JSON.stringify(content, null, 2));
    await writeFile(file, '{"handEdited":true}');
    await prepareWorkspace(job, { home, repoRoot });
    expect(await readFile(file, 'utf8')).toBe('{"handEdited":true}');
  });

  it('overwrites the revision target with the author draft and renders REVISE.md', async () => {
    const first = await prepareWorkspace(job, { home, repoRoot });
    const originalTask = await readFile(join(first.dir, 'TASK.md'), 'utf8');
    await writeFile(first.procedureFile, '{"oldDraft":true}');
    job.kind = 'revise';
    job.instruction = 'Explain how to wipe the lid.';
    job.approvedProcedures = [{ slug: 'clean', content: { oldApproved: true } }];
    job.target = {
      procedureVersionId: 'procedure-1', machineVersionId: 'version-1',
      content: { title: 'Author edited draft', steps: [] }, definition,
      contentHash: 'hash-1', modelUrl: 'https://storage.example/model',
    };
    const result = await prepareWorkspace(job, { home, repoRoot });
    expect(await readFile(result.procedureFile, 'utf8')).toBe(JSON.stringify(job.target.content, null, 2));
    const template = await readFile(join(repoRoot, 'worker/kit/REVISE.md'), 'utf8');
    expect(result.taskPrompt).toBe(renderTemplate(template, {
      PROCEDURE_SLUG: job.procedureSlug, MACHINE_NAME: job.machine.name,
      WORKSPACE: result.dir, INSTRUCTION: job.instruction, REPO: repoRoot,
    }));
    expect(result.taskPrompt).toContain(job.instruction);
    expect(result.taskPrompt).not.toContain('{{');
    expect(await readFile(join(result.dir, 'TASK.md'), 'utf8')).toBe(originalTask);
    expect(await readFile(join(result.dir, 'REVISE.md'), 'utf8')).toBe(result.taskPrompt);
  });

  it('downloads a QuickTime video once and reuses its relative path', async () => {
    job.videoUrl = 'https://storage.example/video';
    const fetchRequest = vi.fn<typeof fetch>(async url => {
      expect(url).toBe(job.videoUrl);
      return new Response('movie bytes', { headers: { 'content-type': 'video/quicktime' } });
    });
    const first = await prepareWorkspace(job, { home, repoRoot, fetch: fetchRequest });
    expect(first.videoFile).toBe('videos/clean/input.mov');
    expect(await readFile(join(first.dir, first.videoFile!), 'utf8')).toBe('movie bytes');
    expect(first.taskPrompt).toContain('videos/clean/input.mov');
    const second = await prepareWorkspace(job, { home, repoRoot, fetch: fetchRequest });
    expect(second.videoFile).toBe(first.videoFile);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    delete job.videoUrl;
    expect((await prepareWorkspace(job, { home, repoRoot })).videoFile).toBe(first.videoFile);
  });

  it.each([
    ['video/mp4', 'mp4'], ['video/webm; codecs=vp9', 'webm'], ['application/octet-stream', 'mp4'],
  ])('uses the correct extension for %s', async (contentType, extension) => {
    job.videoUrl = 'https://storage.example/video';
    const fetchRequest: typeof fetch = async () =>
      new Response('video', { headers: { 'content-type': contentType } });
    const result = await prepareWorkspace(job, { home, repoRoot, fetch: fetchRequest });
    expect(result.videoFile).toBe(`videos/clean/input.${extension}`);
  });

  it.each(['directory', 'wrong symlink', 'correct symlink'])('repairs tooling with a %s', async kind => {
    const first = await prepareWorkspace(job, { home, repoRoot });
    await writeFile(join(first.dir, 'package.json'), '{}');
    const modules = join(first.dir, 'node_modules');
    const original = await lstat(modules);
    if (kind !== 'correct symlink') {
      await rm(modules);
      if (kind === 'directory') {
        await mkdir(modules);
        await writeFile(join(modules, 'stale.txt'), 'stale');
      } else {
        await symlink(join(home, 'missing-modules'), modules);
      }
    }
    await prepareWorkspace(job, { home, repoRoot });
    expect(await readlink(modules)).toBe(join(repoRoot, 'node_modules'));
    expect(JSON.parse(await readFile(join(first.dir, 'package.json'), 'utf8')).scripts.export)
      .toContain(`${repoRoot}/scripts/export-model.ts`);
    if (kind === 'correct symlink') expect((await lstat(modules)).ino).toBe(original.ino);
  });

  it('rejects failed downloads without saving an input video', async () => {
    job.videoUrl = 'https://storage.example/video';
    const fetchRequest: typeof fetch = async () => new Response('Unavailable', { status: 503 });
    await expect(prepareWorkspace(job, { home, repoRoot, fetch: fetchRequest }))
      .rejects.toThrow('Download failed (503)');
    await expect(lstat(join(home, 'machines/machine-1/videos/clean/input.mp4')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects source paths outside the workspace', async () => {
    job.machine.current = {
      machineVersionId: 'version-1', version: 1, definition,
      modelUrl: 'https://storage.example/model', sourceUrl: 'https://storage.example/source',
    };
    const fetchRequest: typeof fetch = async () => Response.json({ '../../escaped.txt': 'escape' });
    await expect(prepareWorkspace(job, { home, repoRoot, fetch: fetchRequest }))
      .rejects.toThrow('Path must stay inside');
    await expect(lstat(join(home, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('renderTemplate', () => {
  it('replaces all occurrences with literal text', () => {
    expect(renderTemplate('{{A}} {{A}} {{B}}', { A: '$&', B: 'done' })).toBe('$& $& done');
  });

  it('throws with the first unsubstituted placeholder in template order', () => {
    expect(() => renderTemplate('{{A}} {{B}} {{C}}', { A: 'x' }))
      .toThrow(new Error('Unsubstituted placeholder: {{B}}'));
  });
});

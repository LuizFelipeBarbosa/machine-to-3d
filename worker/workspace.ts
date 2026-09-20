import { copyFile, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { summarizeGlb } from '../scripts/lib/glb.js';
import { referencedClips, referencedNodes, type MachineDefinition } from '../shared/machine.js';
import type { ClaimedJob } from './types.js';

export type PreparedWorkspace = {
  dir: string;
  mode: 'new-machine' | 'existing-machine';
  taskPrompt: string;
  videoFile: string | null;
  videoDir: string;
  procedureFile: string;
};

export async function prepareWorkspace(
  job: ClaimedJob,
  options: { home: string; repoRoot: string; fetch?: typeof fetch },
): Promise<PreparedWorkspace> {
  const repoRoot = resolve(options.repoRoot);
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const dir = childPath(resolve(options.home, 'machines'), job.workspaceKey);
  const procedureFile = childPath(join(dir, 'procedures'), `${job.procedureSlug}.json`);
  const videoDir = childPath(join(dir, 'videos'), job.procedureSlug);
  if (job.kind === 'revise' && !job.target) {
    throw new Error('Revision job is missing its target procedure');
  }

  await mkdir(join(dir, 'procedures'), { recursive: true });
  await mkdir(join(dir, 'references'), { recursive: true });
  await mkdir(videoDir, { recursive: true });

  const hadModel = await exists(join(dir, 'buildModel.ts'));
  if (!hadModel) await prepareModel(job, dir, repoRoot, fetchRequest);
  const mode = hadModel || job.machine.current ? 'existing-machine' : 'new-machine';

  for (const procedure of job.approvedProcedures) {
    const file = childPath(join(dir, 'procedures'), `${procedure.slug}.json`);
    try {
      await writeFile(file, JSON.stringify(procedure.content, null, 2), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  if (job.kind === 'revise' && job.target) {
    await writeFile(procedureFile, JSON.stringify(job.target.content, null, 2));
  }

  const videoFile = await prepareVideo(job.videoUrl, dir, videoDir, fetchRequest);
  await prepareTooling(job.workspaceKey, dir, repoRoot);

  const templateName = job.kind === 'revise' ? 'REVISE.md' : 'TASK.md';
  const template = await readFile(join(repoRoot, 'worker/kit', templateName), 'utf8');
  const taskPrompt = renderTemplate(template, {
    REPO: repoRoot,
    WORKSPACE: dir,
    MACHINE_SLUG: job.machine.slug,
    MACHINE_NAME: job.machine.name,
    MACHINE_KIND: job.machine.kind,
    PROCEDURE_SLUG: job.procedureSlug,
    PROCEDURE_TITLE: job.title,
    BRIEF: job.brief || '(none)',
    MODE: mode,
    VIDEO_FILE: videoFile ?? '(no video was provided)',
    INSTRUCTION: job.instruction || '(none)',
  });
  await writeFile(join(dir, job.kind === 'revise' ? 'REVISE.md' : 'TASK.md'), taskPrompt);
  return { dir, mode, taskPrompt, videoFile, videoDir, procedureFile };
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.split(`{{${key}}}`).join(value);
  }
  const leftover = rendered.match(/\{\{[^{}]*\}\}/);
  if (leftover) throw new Error(`Unsubstituted placeholder: ${leftover[0]}`);
  return rendered;
}

async function prepareModel(job: ClaimedJob, dir: string, repoRoot: string, fetchRequest: typeof fetch): Promise<void> {
  const current = job.machine.current;
  if (current?.sourceUrl) {
    const response = await download(current.sourceUrl, fetchRequest);
    const source: unknown = JSON.parse(await response.text());
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('Model source bundle must be an object mapping file names to text');
    }
    for (const [name, content] of Object.entries(source)) {
      if (typeof content !== 'string') throw new Error(`Model source file must contain text: ${name}`);
      const file = childPath(dir, name);
      // A persisted workspace can contain symlinks, particularly node_modules.
      // Never restore source through one into the readable repository.
      await rejectSymlinks(dir, file);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    return;
  }
  if (current) {
    const response = await download(current.modelUrl, fetchRequest);
    const model = new Uint8Array(await response.arrayBuffer());
    await writeFile(join(dir, 'model.glb'), model);
    await writeFile(join(dir, 'machine.json'), JSON.stringify(current.definition, null, 2));
    await writeFile(join(dir, 'references/EXISTING.md'), existingMachineReference(
      current.definition as MachineDefinition,
      summarizeGlb(model),
    ));
    return;
  }
  for (const name of ['buildModel.ts', 'machine.json']) {
    await copyFile(join(repoRoot, 'worker/kit/template', name), join(dir, name));
  }
}

function existingMachineReference(definition: MachineDefinition, summary: ReturnType<typeof summarizeGlb>): string {
  const partByName = new Map(definition.parts.map(part => [part.name, part]));
  const nodeLines = referencedNodes(definition).map(name => {
    const part = partByName.get(name);
    return part
      ? `- \`${name}\` — ${part.label}: ${part.blurb}`
      : `- \`${name}\``;
  });
  const stateLines = definition.stateVars.flatMap(stateVar => [
    `- \`${stateVar.name}\` (${stateVar.label}, ${stateVar.kind}) effects JSON: ${JSON.stringify(stateVar.effects)}`,
    '```json',
    JSON.stringify(stateVar.effects, null, 2),
    '```',
  ]);
  const clipLines = referencedClips(definition).map(name => {
    const animation = summary.animations.find(candidate => candidate.name === name);
    return animation
      ? `- \`${name}\` — duration: ${animation.duration} seconds; target nodes: ${animation.targetNodes.join(', ') || '(none)'}`
      : `- \`${name}\` — missing from the downloaded model`;
  });
  const boundingBox = summary.boundingBox
    ? `Bounding box: min ${JSON.stringify(summary.boundingBox.min)}; max ${JSON.stringify(summary.boundingBox.max)}`
    : 'Bounding box: unavailable in the downloaded model';

  return [
    '# Existing machine',
    '',
    'The published model has no editable source. npm run export will overwrite model.glb, so buildModel.ts must be written from scratch to reproduce the published model\'s structure.',
    '',
    `Root node (the exported \`root.name\` must equal it): \`${definition.rootNode}\``,
    '',
    'Exact node names that must exist:',
    ...nodeLines,
    '',
    'State vars and their effects (JSON):',
    ...stateLines,
    '',
    'Animation clips that must exist:',
    ...clipLines,
    '',
    boundingBox,
    '',
    'Keep every listed name; add new parts, state vars and clips freely.',
    '',
  ].join('\n');
}

async function prepareVideo(url: string | undefined, dir: string, videoDir: string, fetchRequest: typeof fetch): Promise<string | null> {
  const entries = await readdir(videoDir, { withFileTypes: true });
  const existing = entries.filter(entry => entry.isFile() && /^input\..+$/.test(entry.name))
    .map(entry => entry.name).sort()[0];
  if (existing) return relative(dir, join(videoDir, existing));
  if (!url) return null;

  const response = await download(url, fetchRequest);
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const extension = contentType === 'video/quicktime' ? 'mov' : contentType === 'video/webm' ? 'webm' : 'mp4';
  const file = join(videoDir, `input.${extension}`);
  await writeFile(file, new Uint8Array(await response.arrayBuffer()));
  return relative(dir, file);
}

async function prepareTooling(workspaceKey: string, dir: string, repoRoot: string): Promise<void> {
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: `${workspaceKey}-workspace`,
    private: true,
    type: 'module',
    scripts: {
      export: `node --import tsx ${shellPath(join(repoRoot, 'scripts/export-model.ts'))} buildModel.ts --out model.glb`,
      validate: `node --import tsx ${shellPath(join(repoRoot, 'worker/kit/validate.ts'))} ${shellPath(dir)}`,
    },
  }, null, 2));

  const modules = join(dir, 'node_modules');
  const target = join(repoRoot, 'node_modules');
  if (await exists(modules)) {
    if ((await lstat(modules)).isSymbolicLink() && resolve(dir, await readlink(modules)) === target) return;
    await rm(modules, { recursive: true, force: true });
  }
  await symlink(target, modules, 'dir');
}

async function download(url: string, fetchRequest: typeof fetch): Promise<Response> {
  const response = await fetchRequest(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return response;
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

function childPath(parent: string, name: string): string {
  const file = resolve(parent, name);
  const path = relative(parent, file);
  if (isAbsolute(name) || !path || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(`Path must stay inside ${parent}: ${name}`);
  }
  return file;
}

async function rejectSymlinks(dir: string, file: string): Promise<void> {
  let path = dir;
  for (const component of relative(dir, file).split(sep)) {
    path = join(path, component);
    if (await exists(path) && (await lstat(path)).isSymbolicLink()) {
      throw new Error(`Model source path must not be a symlink: ${path}`);
    }
  }
}

function shellPath(path: string): string {
  return /^[\w/.-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

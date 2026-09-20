import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const argv = process.argv.slice(2);
process.stdin.setEncoding('utf8');
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

console.log(JSON.stringify({ type: 'thread.started', thread_id: 'stub-session' }));

const workspaceIndex = argv.indexOf('-C');
const outputIndex = argv.indexOf('-o');
if (outputIndex === -1 || !argv[outputIndex + 1]) throw new Error('Missing -o argument');
const workspace = workspaceIndex === -1 ? process.cwd() : argv[workspaceIndex + 1];

if (process.env.STUB_MODE === 'resume-fails' && argv.includes('resume')) {
  console.error('error: session not found');
  process.exitCode = 1;
} else if (process.env.STUB_MODE === 'fail-503'
  || (process.env.STUB_MODE === 'fail-503-once' && !existsSync(join(workspace, '.stub-fail-503-once')))
  || (process.env.STUB_MODE === 'fail-capacity-once' && !existsSync(join(workspace, '.stub-fail-capacity-once')))) {
  if (process.env.STUB_MODE === 'fail-503-once') {
    await writeFile(join(workspace, '.stub-fail-503-once'), 'failed');
  } else if (process.env.STUB_MODE === 'fail-capacity-once') {
    await writeFile(join(workspace, '.stub-fail-capacity-once'), 'failed');
  }
  console.log(process.env.STUB_MODE === 'fail-capacity-once'
    ? 'Selected model is at capacity. Please try a different model.'
    : 'Reconnecting... unexpected status 503 Service Unavailable: server_is_overloaded');
  process.exitCode = 1;
} else {
  if (!existsSync(join(workspace, 'buildModel.ts'))) {
    for (const file of ['buildModel.ts', 'machine.json']) {
      await copyFile(new URL(`../kit/template/${file}`, import.meta.url), join(workspace, file));
    }
  }

  const slug = process.env.STUB_PROCEDURE_SLUG || 'demo';
  let firstFrameFile;
  try {
    const frames = JSON.parse(await readFile(join(workspace, 'videos', slug, 'frames/index.json'), 'utf8'));
    firstFrameFile = frames[0]?.file;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(join(workspace, 'procedures'), { recursive: true });
  await writeFile(join(workspace, 'procedures', `${slug}.json`), JSON.stringify({
    formatVersion: 1,
    title: 'Inspect the kit box',
    summary: 'Open the door and record the inspection.',
    minutes: 2,
    start: { doorOpen: false },
    steps: [
      {
        id: `${slug}-01`, title: 'Open the door', body: 'Swing the door open.',
        where: 'instrument', parts: ['door'],
        view: { pos: [0, 0, 0], target: [0, 0, 0] },
        state: { doorOpen: true }, check: 'I have opened the chamber door',
        provenance: 'observed', sourceTimestamp: 2,
        ...(firstFrameFile ? { media: { fileId: `videos/${slug}/frames/${firstFrameFile}`, alt: 'frame' } } : {}),
      },
      {
        id: `${slug}-02`, title: 'Record the inspection', body: 'Record the result in the logbook.',
        where: 'logbook', parts: [], view: { pos: [0, 0, 0], target: [0, 0, 0] },
        provenance: 'inferred', uncertainty: 'not shown',
      },
    ],
  }));

  if (process.env.STUB_MODE === 'rename-door') {
    const file = join(workspace, 'machine.json');
    const definition = JSON.parse(await readFile(file, 'utf8'));
    definition.parts.find(part => part.name === 'door').name = 'hatch';
    await writeFile(file, JSON.stringify(definition));
    const source = join(workspace, 'buildModel.ts');
    await writeFile(source, (await readFile(source, 'utf8')).replaceAll("'door'", "'hatch'"));
  }

  const notes = argv.includes('resume') ? 'stub (resumed)' : 'stub';
  await writeFile(argv[outputIndex + 1], JSON.stringify({
    status: process.env.STUB_MODE === 'blocked' ? 'blocked' : 'complete',
    modelChanged: true,
    instrument: { name: 'Kit box', confidence: 'high' },
    procedureSlug: slug,
    stepsObserved: 1,
    stepsInferred: 1,
    uncertainties: [],
    notes,
  }));
}

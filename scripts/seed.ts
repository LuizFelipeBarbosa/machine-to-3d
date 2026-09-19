import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import type { ZodType } from 'zod';
import { SEED_MACHINES } from '../seed/manifest';
import type { SeedMachine } from '../seed/manifest';
import { MachineDefinitionSchema, referencedClips, referencedNodes } from '../shared/machine';
import type { MachineDefinition } from '../shared/machine';
import { ProcedureContentSchema } from '../shared/procedure';
import type { ProcedureContent } from '../shared/procedure';
import { validateProcedure } from '../shared/validateProcedure';
import type { LinkTargets } from '../shared/validateProcedure';
import { summarizeGlb } from './lib/glb';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

type ValidatedMachine = {
  machine: SeedMachine;
  definition: MachineDefinition;
  model: Buffer;
  nodeCount: number;
  procedures: { slug: string; content: ProcedureContent }[];
  linkTargets: LinkTargets;
};

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object).sort().map((key) => [key, sortObjectKeys(object[key])]),
    );
  }
  return value;
}

function definitionsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortObjectKeys(left)) === JSON.stringify(sortObjectKeys(right));
}

function readContent<T>(path: string, schema: ZodType<T>, issues: string[]): T | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(resolve(projectRoot, path), 'utf8'));
    return schema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      for (const issue of error.issues) {
        issues.push(`${path}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
    } else {
      issues.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }
}

function mediaReferences(content: ProcedureContent): { fileId: string }[] {
  const references: { fileId: string }[] = content.steps.flatMap((step) => step.media ? [step.media] : []);
  if (content.video) references.push(content.video);
  return references;
}

function seedMediaFile(machine: SeedMachine, fileId: string) {
  const extension = extname(fileId).toLowerCase();
  // Existing storage ids have no extension or path separator.
  if (!extension && !fileId.includes('/')) return undefined;

  const directory = resolve(projectRoot, machine.dir);
  const path = resolve(directory, fileId);
  if (isAbsolute(fileId) || !path.startsWith(`${directory}${sep}`)) {
    throw new Error(`Media must be a relative path under ${machine.dir}: ${fileId}`);
  }
  const contentTypes: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
  };
  const contentType = contentTypes[extension];
  if (!contentType) throw new Error(`Unsupported media extension: ${fileId}`);
  return { path, contentType };
}

function validateSeeds(): ValidatedMachine[] {
  const issues: string[] = [];
  const validated: ValidatedMachine[] = [];
  for (const machine of SEED_MACHINES) {
    const definition = readContent(`${machine.dir}/machine.json`, MachineDefinitionSchema, issues);
    let model: Buffer | undefined;
    let nodeCount = 0;
    try {
      model = readFileSync(resolve(projectRoot, machine.dir, 'model.glb'));
      const summary = summarizeGlb(model);
      if (summary.duplicateNames.length > 0) {
        issues.push(`${machine.dir}/model.glb: Duplicate node names: ${summary.duplicateNames.join(', ')}`);
      }
      nodeCount = summary.nodeCount;
      if (definition !== undefined) {
        if (summary.rootNodes.length !== 1 || summary.rootNodes[0] !== definition.rootNode) {
          issues.push(`${machine.dir}/model.glb: Expected exactly one root named "${definition.rootNode}"; found ${JSON.stringify(summary.rootNodes)}`);
        }
        const nodes = new Set(summary.namedNodes);
        for (const name of referencedNodes(definition)) {
          if (!nodes.has(name)) {
            issues.push(`${machine.dir}/model.glb: Missing referenced node "${name}"`);
          }
        }
        const clipNames = new Set(summary.animations.map((animation) => animation.name));
        for (const name of referencedClips(definition)) {
          if (!clipNames.has(name)) {
            issues.push(`${machine.dir}/model.glb: Missing referenced animation clip "${name}"`);
          }
        }
      }
    } catch (error) {
      issues.push(`${machine.dir}/model.glb: ${error instanceof Error ? error.message : String(error)}`);
    }

    const procedures: ValidatedMachine['procedures'] = [];
    for (const slug of machine.procedureSlugs) {
      const content = readContent(`${machine.dir}/procedures/${slug}.json`, ProcedureContentSchema, issues);
      if (content !== undefined) {
        for (const { fileId } of mediaReferences(content)) {
          try {
            const file = seedMediaFile(machine, fileId);
            if (file && !statSync(file.path).isFile()) {
              throw new Error(`Not a media file: ${fileId}`);
            }
          } catch (error) {
            issues.push(`${machine.dir}/procedures/${slug}.json: ${fileId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        procedures.push({ slug, content });
      }
    }
    // Build all targets before validating so forward and circular links resolve.
    const linkTargets = Object.fromEntries(procedures.map(({ slug, content }) => [
      slug, content.steps.map((step) => step.id),
    ]));
    if (definition !== undefined) {
      for (const { slug, content } of procedures) {
        for (const issue of validateProcedure(content, definition, linkTargets)) {
          issues.push(`${machine.dir}/procedures/${slug}.json: ${issue.path}: ${issue.message}`);
        }
      }
      if (model !== undefined) {
        validated.push({ machine, definition, model, nodeCount, procedures, linkTargets });
      }
    }
  }
  if (issues.length > 0) {
    throw new Error(`Seed validation failed:\n${issues.join('\n')}`);
  }
  return validated;
}

function runConvex<T>(name: string, args: Record<string, unknown>): T {
  const stdout = execFileSync('npx', ['convex', 'run', name, JSON.stringify(args)], {
    encoding: 'utf8',
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(stdout) as T;
}

async function uploadFile(data: Buffer, contentType: string): Promise<string> {
  const url = runConvex<string>('seed:uploadUrl', {});
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: new Uint8Array(data),
  });
  if (!response.ok) {
    throw new Error(`File upload failed (${response.status}): ${await response.text()}`);
  }
  const result: unknown = await response.json();
  if (
    typeof result !== 'object' || result === null ||
    !('storageId' in result) || typeof result.storageId !== 'string'
  ) {
    throw new Error('File upload did not return a storageId');
  }
  return result.storageId;
}

async function uploadProcedureMedia(
  machine: SeedMachine,
  original: ProcedureContent,
  uploadedFiles: Map<string, string>,
) {
  const content = structuredClone(original);
  const mediaKeys: Record<string, string> = {};
  for (const reference of mediaReferences(content)) {
    const relativePath = reference.fileId;
    const file = seedMediaFile(machine, relativePath);
    if (!file) continue;
    let storageId = uploadedFiles.get(file.path);
    if (!storageId) {
      storageId = await uploadFile(readFileSync(file.path), file.contentType);
      uploadedFiles.set(file.path, storageId);
    }
    reference.fileId = storageId;
    mediaKeys[storageId] = relativePath;
  }
  return { content, mediaKeys };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  if (force) {
    console.log('--force overrides human-authored procedures; use only on development deployments');
  }
  if (args.some((arg) => arg !== '--dry-run' && arg !== '--force')) {
    throw new Error('Usage: npx tsx scripts/seed.ts [--dry-run] [--force]');
  }
  const validated = validateSeeds();
  console.table(validated.map(({ machine, nodeCount, procedures }) => ({
    machine: machine.slug,
    'nodes ok': nodeCount,
    'procedures ok': procedures.length,
  })));
  if (args.includes('--dry-run')) {
    console.log(`Dry run complete: ${validated.length} machines validated; no deployment calls made.`);
    return;
  }

  let machinesCreated = 0;
  let machinesUpdated = 0;
  let machinesUnchanged = 0;
  let proceduresCreated = 0;
  let proceduresUpdated = 0;
  let proceduresForced = 0;
  let proceduresUnchanged = 0;
  let proceduresHumanAuthored = 0;
  const uploadedFiles = new Map<string, string>();
  for (const { machine, definition, model, procedures, linkTargets } of validated) {
    const { slug, name, kind } = machine;
    const status = runConvex<{
      exists: boolean;
      definition?: MachineDefinition;
      version?: number;
    }>('seed:machineStatus', { slug });
    if (status.exists && definitionsEqual(definition, status.definition)) {
      machinesUnchanged++;
      console.log(`${slug}: unchanged`);
    } else {
      const modelFileId = await uploadFile(model, 'model/gltf-binary');
      const result = runConvex<{ created: boolean; updated: boolean; version?: number }>('seed:upsertMachine', {
        slug, name, kind, modelFileId, definition,
      });
      if (result.created) {
        machinesCreated++;
        console.log(`${slug}: created v1`);
      } else if (result.updated) {
        machinesUpdated++;
        console.log(`${slug}: updated to v${result.version}`);
      } else {
        machinesUnchanged++;
        console.log(`${slug}: unchanged`);
      }
    }
    for (const procedure of procedures) {
      const { content, mediaKeys } = await uploadProcedureMedia(machine, procedure.content, uploadedFiles);
      const result = runConvex<
        | { created: true; updated: false; versionId: string; version: number }
        | { created: false; updated: true; versionId: string; version: number }
        | { created: false; updated: true; versionId: string; version: number; forced: true }
        | { created: false; updated: false; reason: 'unchanged' | 'human-authored' }
      >('seed:upsertProcedure', {
        machineSlug: slug,
        slug: procedure.slug,
        content,
        mediaKeys,
        linkTargets,
        force,
      });
      if (result.created) {
        proceduresCreated++;
        console.log(`${slug}/${procedure.slug}: created`);
      } else if (result.updated) {
        if ('forced' in result && result.forced) {
          proceduresForced++;
          console.log(`${slug}/${procedure.slug}: updated to v${result.version} (forced)`);
        } else {
          proceduresUpdated++;
          console.log(`${slug}/${procedure.slug}: updated to v${result.version}`);
        }
      } else if (result.reason === 'unchanged') {
        proceduresUnchanged++;
        console.log(`${slug}/${procedure.slug}: unchanged`);
      } else {
        proceduresHumanAuthored++;
        console.log(`${slug}/${procedure.slug}: left alone (human-authored)`);
      }
    }
  }
  console.log(`Seed complete: machines ${machinesCreated} created, ${machinesUpdated} updated, ${machinesUnchanged} unchanged; procedures ${proceduresCreated} created, ${proceduresUpdated} updated, ${proceduresUnchanged} unchanged, ${proceduresHumanAuthored} human-authored, ${proceduresForced} forced.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

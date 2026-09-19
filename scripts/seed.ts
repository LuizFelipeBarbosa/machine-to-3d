import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import type { ZodType } from 'zod';
import { SEED_MACHINES } from '../seed/manifest';
import type { SeedMachine } from '../seed/manifest';
import { MachineDefinitionSchema, referencedNodes } from '../shared/machine';
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
      }
    } catch (error) {
      issues.push(`${machine.dir}/model.glb: ${error instanceof Error ? error.message : String(error)}`);
    }

    const procedures: ValidatedMachine['procedures'] = [];
    for (const slug of machine.procedureSlugs) {
      const content = readContent(`${machine.dir}/procedures/${slug}.json`, ProcedureContentSchema, issues);
      if (content !== undefined) {
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

async function uploadModel(model: Buffer): Promise<string> {
  const url = runConvex<string>('seed:uploadUrl', {});
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'model/gltf-binary' },
    body: new Uint8Array(model),
  });
  if (!response.ok) {
    throw new Error(`Model upload failed (${response.status}): ${await response.text()}`);
  }
  const result: unknown = await response.json();
  if (
    typeof result !== 'object' || result === null ||
    !('storageId' in result) || typeof result.storageId !== 'string'
  ) {
    throw new Error('Model upload did not return a storageId');
  }
  return result.storageId;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--dry-run')) {
    throw new Error('Usage: npx tsx scripts/seed.ts [--dry-run]');
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
  let proceduresCreated = 0;
  let proceduresSkipped = 0;
  for (const { machine, definition, model, procedures, linkTargets } of validated) {
    const { slug, name, kind } = machine;
    if (runConvex<boolean>('seed:machineExists', { slug })) {
      console.log(`${slug}: skip machine (already exists)`);
    } else {
      const modelFileId = await uploadModel(model);
      const result = runConvex<{ created: boolean }>('seed:upsertMachine', {
        slug, name, kind, modelFileId, definition,
      });
      if (result.created) {
        machinesCreated++;
      }
      console.log(`${slug}: ${result.created ? 'created' : 'skip'} machine`);
    }
    for (const procedure of procedures) {
      const result = runConvex<{ created: boolean }>('seed:upsertProcedure', {
        machineSlug: slug,
        slug: procedure.slug,
        content: procedure.content,
        linkTargets,
      });
      if (result.created) {
        proceduresCreated++;
      } else {
        proceduresSkipped++;
      }
      console.log(`${slug}/${procedure.slug}: ${result.created ? 'created' : 'skip'} procedure`);
    }
  }
  console.log(`Seed complete: machines ${machinesCreated} created, ${validated.length - machinesCreated} skipped; procedures ${proceduresCreated} created, ${proceduresSkipped} skipped.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

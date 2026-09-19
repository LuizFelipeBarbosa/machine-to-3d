import type { z } from 'zod';
import { SEED_MACHINES } from '../../seed/manifest';
import { MachineDefinitionSchema } from '../../shared/machine';
import { ProcedureContentSchema } from '../../shared/procedure';
import type { Catalog, ProcedureRecord } from './catalog';

type SeedMachine = {
  slug: string;
  name: string;
  kind: string;
  dir: string;
  procedureSlugs: readonly string[];
};

const machines: readonly SeedMachine[] = SEED_MACHINES;

function validateFiles<T>(files: Record<string, unknown>, schema: z.ZodType<T>): Map<string, T> {
  const validated = new Map<string, T>();
  for (const [path, json] of Object.entries(files)) {
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new Error(`Invalid seed content in ${path}: ${result.error.message}`);
    }
    validated.set(path, result.data);
  }
  return validated;
}

const definitions = validateFiles(
  import.meta.glob('../../seed/*/machine.json', { eager: true, import: 'default' }),
  MachineDefinitionSchema,
);
const procedures = validateFiles(
  import.meta.glob('../../seed/*/procedures/*.json', { eager: true, import: 'default' }),
  ProcedureContentSchema,
);
const modelUrls = import.meta.glob<string>('../../seed/*/model.glb', {
  eager: true,
  query: '?url',
  import: 'default',
});

// The manifest controls membership and ordering; absent files are allowed while seeding.
function proceduresForMachine(machine: SeedMachine): ProcedureRecord[] {
  const records: ProcedureRecord[] = [];
  for (const slug of machine.procedureSlugs) {
    const content = procedures.get(`../../seed/${machine.dir}/procedures/${slug}.json`);
    if (content) {
      records.push({ slug, machineSlug: machine.slug, content, placeholder: true });
    }
  }
  return records;
}

export const localCatalog: Catalog = {
  async listMachines() {
    return machines.map((machine) => ({
      slug: machine.slug,
      name: machine.name,
      kind: machine.kind,
      procedures: proceduresForMachine(machine).map(({ slug, content }) => ({
        slug,
        title: content.title,
        minutes: content.minutes,
      })),
    }));
  },

  async getMachine(slug) {
    const machine = machines.find((entry) => entry.slug === slug);
    if (!machine) return null;

    const definition = definitions.get(`../../seed/${machine.dir}/machine.json`);
    const modelUrl = modelUrls[`../../seed/${machine.dir}/model.glb`];
    if (!definition || !modelUrl) return null;

    return { slug, name: machine.name, kind: machine.kind, modelUrl, definition };
  },

  async getProcedure(machineSlug, procedureSlug) {
    const machine = machines.find((entry) => entry.slug === machineSlug);
    if (!machine) return null;

    return proceduresForMachine(machine).find((procedure) => procedure.slug === procedureSlug) ?? null;
  },

  async listStepIds(machineSlug) {
    const machine = machines.find((entry) => entry.slug === machineSlug);
    if (!machine) return {};

    return Object.fromEntries(
      proceduresForMachine(machine).map(({ slug, content }) => [
        slug,
        content.steps.map((step) => step.id),
      ]),
    );
  },
};

export type SeedMachine = {
  slug: string;
  name: string;
  kind: string;
  dir: string;
  procedureSlugs: string[];
};

export const SEED_MACHINES: SeedMachine[] = [
  {
    slug: 'park-nx10',
    name: 'Park NX10',
    kind: 'Atomic force microscope',
    dir: 'seed/park-nx10',
    procedureSlugs: ['nc-scan', 'probe-exchange', 'shutdown'],
  },
  {
    slug: 'zeiss-axioscope-5',
    name: 'ZEISS Axioscope 5',
    kind: 'Upright light microscope',
    dir: 'seed/zeiss-axioscope-5',
    procedureSlugs: [],
  },
  {
    slug: 'hq-graphene-transfer',
    name: 'HQ Graphene manual transfer system',
    kind: '2D-material transfer station',
    dir: 'seed/hq-graphene-transfer',
    procedureSlugs: [],
  },
  {
    slug: 'nanofrazor',
    name: 'NanoFrazor benchtop',
    kind: 'Thermal scanning-probe lithography',
    dir: 'seed/nanofrazor',
    procedureSlugs: [],
  },
  {
    slug: 'plasma-etch-pe25',
    name: 'Plasma Etch PE-25',
    kind: 'Benchtop plasma cleaner',
    dir: 'seed/plasma-etch-pe25',
    procedureSlugs: [],
  },
  {
    slug: 'horiba-labram-odyssey',
    name: 'HORIBA LabRAM Odyssey',
    kind: 'Raman microscope',
    dir: 'seed/horiba-labram-odyssey',
    procedureSlugs: [],
  },
  {
    slug: 'nexdep',
    name: 'Angstrom Nexdep',
    kind: 'Thin-film deposition system',
    dir: 'seed/nexdep',
    procedureSlugs: [],
  },
  {
    slug: 'ppms-dynacool',
    name: 'Quantum Design PPMS DynaCool',
    kind: 'Physical property measurement system',
    dir: 'seed/ppms-dynacool',
    procedureSlugs: [],
  },
  {
    slug: 'rise-raman-sem',
    name: 'RISE Raman-SEM',
    kind: 'Correlative Raman + scanning electron microscope',
    dir: 'seed/rise-raman-sem',
    procedureSlugs: [],
  },
  {
    slug: 'teslatronpt-plus',
    name: 'TeslatronPT Plus',
    kind: 'Cryogen-free superconducting magnet system',
    dir: 'seed/teslatronpt-plus',
    procedureSlugs: [],
  },
];

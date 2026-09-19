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
    slug: 'cryoraman',
    name: 'WITec attocube cryoRaman',
    kind: 'Cryogenic Raman microscope',
    dir: 'seed/cryoraman',
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
];

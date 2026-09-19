import type { MachineDefinition } from '../../shared/machine';
import type { ProcedureContent } from '../../shared/procedure';
export type MachineSummary = { slug: string; name: string; kind: string; procedures: { slug: string; title: string; minutes: number }[] };
export type MachineRecord = { slug: string; name: string; kind: string; modelUrl: string; definition: MachineDefinition };
export type ProcedureRecord = {
  slug: string;
  machineSlug: string;
  content: ProcedureContent;
  placeholder: boolean;
  versionId?: string;
  mediaUrls?: Record<string, string>;
  /** The machine snapshot approved with this procedure, when served by the backend. */
  machineVersion?: Pick<MachineRecord, 'modelUrl' | 'definition'>;
};
export type Catalog = {
  listMachines(): Promise<MachineSummary[]>;
  getMachine(slug: string): Promise<MachineRecord | null>;
  getProcedure(machineSlug: string, procedureSlug: string): Promise<ProcedureRecord | null>;
  /** slug → step ids, for every procedure of the machine (used for link validation/resolution) */
  listStepIds(machineSlug: string): Promise<Record<string, string[]>>;
};

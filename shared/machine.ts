import { z } from 'zod';

export const Vec3Schema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);

export const ViewSchema = z.object({
  pos: Vec3Schema,
  target: Vec3Schema,
}).strict();

export const EffectSchema = z.discriminatedUnion('type', [
  // The node is shown only while the state variable is on.
  z.object({
    type: z.literal('visible'),
    node: z.string(),
  }).strict(),
  // Offset times the eased value, additive per node.
  z.object({
    type: z.literal('translate'),
    node: z.string(),
    offset: Vec3Schema,
  }).strict(),
  // Angle in radians times the eased value, about the node's origin.
  z.object({
    type: z.literal('rotate'),
    node: z.string(),
    axis: z.enum(['x', 'y', 'z']),
    angle: z.number(),
  }).strict(),
  // Scrubs the named GLB animation clip to `value × duration`. Nodes the clip animates must
  // not also be targets of translate/rotate effects; that is checked against the GLB at load.
  z.object({
    type: z.literal('clip'),
    clip: z.string().min(1),
  }).strict(),
]);

export const StateVarSchema = z.object({
  name: z.string().min(1),
  label: z.string(),
  /** fraction: a 0..1 progress value; with a clip effect it is the clip's progress;
   * with translate/rotate it scales the offset/angle */
  kind: z.enum(['toggle', 'fraction']),
  userToggle: z.boolean().optional(),
  effects: z.array(EffectSchema).min(1),
}).strict();

export const PartSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  blurb: z.string(),
}).strict();

export const PresetViewSchema = z.object({
  name: z.string().min(1),
  label: z.string(),
  view: ViewSchema,
}).strict();

function rejectDuplicateNames(
  items: { name: string }[],
  field: string,
  context: z.RefinementCtx,
): void {
  const names = new Set<string>();
  items.forEach((item, index) => {
    if (names.has(item.name)) {
      context.addIssue({
        code: 'custom',
        path: [field, index, 'name'],
        message: `Duplicate name "${item.name}".`,
      });
    }
    names.add(item.name);
  });
}

function rejectSharedClips(
  definition: { stateVars: StateVar[] },
  context: z.RefinementCtx,
): void {
  const owners = new Map<string, number>();
  definition.stateVars.forEach((stateVar, index) => {
    for (const effect of stateVar.effects) {
      if (effect.type !== 'clip') {
        continue;
      }
      const owner = owners.get(effect.clip);
      if (owner !== undefined && owner !== index) {
        context.addIssue({
          code: 'custom',
          path: ['stateVars', index, 'effects'],
          message: `Clip "${effect.clip}" is referenced by more than one state var`,
        });
      }
      owners.set(effect.clip, index);
    }
  });
}

export const MachineDefinitionSchema = z.object({
  formatVersion: z.literal(1),
  rootNode: z.string().min(1),
  // Arrays preserve the authored order shown in the UI.
  parts: z.array(PartSchema),
  presetViews: z.array(PresetViewSchema),
  stateVars: z.array(StateVarSchema),
}).strict().superRefine((definition, context) => {
  rejectDuplicateNames(definition.parts, 'parts', context);
  rejectDuplicateNames(definition.presetViews, 'presetViews', context);
  rejectDuplicateNames(definition.stateVars, 'stateVars', context);
  rejectSharedClips(definition, context);
});

export type Vec3 = z.infer<typeof Vec3Schema>;
export type View = z.infer<typeof ViewSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type StateVar = z.infer<typeof StateVarSchema>;
export type Part = z.infer<typeof PartSchema>;
export type PresetView = z.infer<typeof PresetViewSchema>;
export type MachineDefinition = z.infer<typeof MachineDefinitionSchema>;
export type MachineState = Record<string, boolean | number>;

/** Every node name the definition refers to: rootNode, part names and effect nodes
 * (deduplicated, first-seen order). Used to check a definition against a GLB's node names. */
export function referencedNodes(definition: MachineDefinition): string[] {
  const nodes = new Set<string>([definition.rootNode]);
  for (const part of definition.parts) {
    nodes.add(part.name);
  }
  for (const stateVar of definition.stateVars) {
    for (const effect of stateVar.effects) {
      if (effect.type !== 'clip') {
        nodes.add(effect.node);
      }
    }
  }
  return [...nodes];
}

/** Unique clip names referenced by any state var's effects, in first-seen order. */
export function referencedClips(definition: MachineDefinition): string[] {
  const clips = new Set<string>();
  for (const stateVar of definition.stateVars) {
    for (const effect of stateVar.effects) {
      if (effect.type === 'clip') {
        clips.add(effect.clip);
      }
    }
  }
  return [...clips];
}

export function findPart(definition: MachineDefinition, name: string): Part | undefined {
  return definition.parts.find((part) => part.name === name);
}

export function findStateVar(
  definition: MachineDefinition,
  name: string,
): StateVar | undefined {
  return definition.stateVars.find((stateVar) => stateVar.name === name);
}

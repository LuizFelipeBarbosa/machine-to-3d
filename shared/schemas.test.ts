import { describe, it, expect } from 'vitest';
import {
  EffectSchema,
  MachineDefinitionSchema,
  PartSchema,
  PresetViewSchema,
  StateVarSchema,
  Vec3Schema,
  ViewSchema,
  findPart,
  findStateVar,
  referencedClips,
  referencedNodes,
} from './machine';
import type { MachineDefinition } from './machine';
import {
  ProcedureContentSchema,
  StepLinkSchema,
  StepMediaSchema,
  StepSchema,
} from './procedure';
import type { ProcedureContent } from './procedure';

function makeMachine(): MachineDefinition {
  return {
    formatVersion: 1,
    rootNode: 'Park_NX10',
    parts: [
      { name: 'head', label: 'Head', blurb: 'The microscope head.' },
      { name: 'z', label: 'Z stage', blurb: 'Positions the head vertically.' },
      { name: 'sample', label: 'Sample stage', blurb: 'Holds the specimen.' },
    ],
    presetViews: [
      { name: 'front', label: 'Front', view: { pos: [1, 1, 1], target: [0, 0, 0] } },
    ],
    stateVars: [
      {
        name: 'lift', label: 'Head raised', kind: 'toggle',
        effects: [
          { type: 'translate', node: 'head', offset: [0, 0.3, 0] },
          { type: 'translate', node: 'zCarriage', offset: [0, 0.3, 0] },
        ],
      },
      {
        name: 'sample', label: 'Sample loaded', kind: 'toggle',
        effects: [{ type: 'visible', node: 'specimen' }],
      },
    ],
  };
}

function makeProcedure(): ProcedureContent {
  return {
    formatVersion: 1,
    title: 'Load an AFM sample',
    summary: 'Prepare the microscope for scanning.',
    minutes: 5,
    start: { lift: false, sample: false },
    steps: [{
      id: 'raise',
      title: 'Raise the head',
      where: 'instrument',
      body: 'Raise the head to access the sample stage.',
      parts: ['head', 'z', 'sample'],
      view: { pos: [1, 1, 1], target: [0, 0, 0] },
      state: { lift: true },
      caution: 'Keep clear of the moving head.',
      check: 'The sample stage is accessible.',
      media: { fileId: 'head-photo', alt: 'The head in its raised position.' },
      link: { procedureSlug: 'scan', stepId: 'align', label: 'Align the laser' },
    }],
  };
}

describe('schemas', () => {
  it('parses a valid machine and procedure, preserving authored array order', () => {
    const machine = makeMachine();
    const content = makeProcedure();
    expect(MachineDefinitionSchema.parse(machine)).toEqual(machine);
    expect(ProcedureContentSchema.parse(content)).toEqual(content);
  });

  it('accepts all four effect types', () => {
    const effects = [
      { type: 'visible', node: 'specimen' },
      { type: 'translate', node: 'head', offset: [0, 0.3, 0] },
      { type: 'rotate', node: 'head', axis: 'y', angle: Math.PI / 2 },
      { type: 'clip', clip: 'OpenDoor' },
    ];
    for (const effect of effects) {
      expect(EffectSchema.parse(effect)).toEqual(effect);
    }
  });

  it('rejects an unknown effect type', () => {
    expect(EffectSchema.safeParse({ type: 'scale', node: 'head' }).success).toBe(false);
  });

  it('rejects clip effects with a node or an empty clip name', () => {
    expect(EffectSchema.safeParse({ type: 'clip', clip: 'OpenDoor', node: 'head' }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: 'clip', clip: '' }).success).toBe(false);
  });

  it('rejects a clip shared by different state variables', () => {
    const machine = makeMachine();
    machine.stateVars[0].effects.push({ type: 'clip', clip: 'OpenDoor' });
    machine.stateVars[1].effects.push({ type: 'clip', clip: 'OpenDoor' });
    const result = MachineDefinitionSchema.safeParse(machine);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        'Clip "OpenDoor" is referenced by more than one state var',
      );
    }
  });

  it('accepts repeated clip references within one state variable and distinct clips across variables', () => {
    const machine = makeMachine();
    machine.stateVars[0].effects.push(
      { type: 'clip', clip: 'OpenDoor' },
      { type: 'clip', clip: 'OpenDoor' },
    );
    machine.stateVars[1].effects.push({ type: 'clip', clip: 'LoadSample' });
    expect(MachineDefinitionSchema.parse(machine)).toEqual(machine);
  });

  it('rejects unknown keys in every object schema', () => {
    const machine = makeMachine();
    const content = makeProcedure();
    const examples = [
      { schema: MachineDefinitionSchema, value: machine },
      { schema: PartSchema, value: machine.parts[0] },
      { schema: PresetViewSchema, value: machine.presetViews[0] },
      { schema: StateVarSchema, value: machine.stateVars[0] },
      { schema: ViewSchema, value: content.steps[0].view },
      { schema: EffectSchema, value: { type: 'visible', node: 'head' } },
      { schema: EffectSchema, value: { type: 'translate', node: 'head', offset: [0, 0.3, 0] } },
      { schema: EffectSchema, value: { type: 'rotate', node: 'head', axis: 'x', angle: 1 } },
      { schema: EffectSchema, value: { type: 'clip', clip: 'OpenDoor' } },
      { schema: ProcedureContentSchema, value: content },
      { schema: StepSchema, value: content.steps[0] },
      { schema: StepMediaSchema, value: content.steps[0].media },
      { schema: StepLinkSchema, value: content.steps[0].link },
    ];
    for (const { schema, value } of examples) {
      expect(schema.safeParse({ ...value, extra: true }).success).toBe(false);
    }
  });

  it.each([undefined, 0, 2, '1', null])('rejects formatVersion %s in both documents', (formatVersion) => {
    expect(MachineDefinitionSchema.safeParse({ ...makeMachine(), formatVersion }).success).toBe(false);
    expect(ProcedureContentSchema.safeParse({ ...makeProcedure(), formatVersion }).success).toBe(false);
  });

  it.each(['parts', 'presetViews', 'stateVars'] as const)(
    'rejects duplicate names in %s with the path of each later duplicate',
    (field) => {
      const machine = makeMachine();
      const entries = machine[field];
      const result = MachineDefinitionSchema.safeParse({
        ...machine,
        [field]: [...entries, entries[0], entries[0]],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toEqual([
          [field, entries.length, 'name'],
          [field, entries.length + 1, 'name'],
        ]);
      }
    },
  );

  it.each([
    [0, 0], [0, 0, 0, 0], [0, '0', 0],
    [NaN, 0, 0], [0, Infinity, 0], [0, 0, -Infinity],
  ])('rejects an invalid vector %j', (...coordinates) => {
    expect(Vec3Schema.safeParse(coordinates).success).toBe(false);
  });

  it.each([0, -1, 1.5, Infinity, NaN])('rejects invalid minutes %s', (minutes) => {
    expect(ProcedureContentSchema.safeParse({ ...makeProcedure(), minutes }).success).toBe(false);
  });

  it.each([0, 0.18, 1])('accepts fraction state values of %s', (value) => {
    const content = makeProcedure();
    expect(ProcedureContentSchema.parse({ ...content, start: { lift: value } }).start.lift).toBe(value);
    expect(StepSchema.parse({ ...content.steps[0], state: { lift: value } }).state?.lift).toBe(value);
  });

  it('rejects out-of-range and string state values', () => {
    const content = makeProcedure();
    expect(ProcedureContentSchema.safeParse({ ...content, start: { lift: 1.1 } }).success).toBe(false);
    expect(ProcedureContentSchema.safeParse({ ...content, start: { lift: 'true' } }).success).toBe(false);
    expect(StepSchema.safeParse({ ...content.steps[0], state: { lift: 'true' } }).success).toBe(false);
  });

  it.each(['observed', 'inferred'] as const)('accepts %s step provenance with uncertainty and a source timestamp', (provenance) => {
    const step = {
      ...makeProcedure().steps[0],
      provenance,
      uncertainty: 'Confirm the head clearance.',
      sourceTimestamp: 12.5,
    };
    expect(StepSchema.parse(step)).toEqual(step);
  });

  it('rejects a negative source timestamp', () => {
    expect(StepSchema.safeParse({ ...makeProcedure().steps[0], sourceTimestamp: -1 }).success).toBe(false);
  });

  it('rejects unknown step keys even with provenance metadata', () => {
    expect(StepSchema.safeParse({
      ...makeProcedure().steps[0], provenance: 'observed', extra: true,
    }).success).toBe(false);
  });

  it('rejects an invalid step provenance', () => {
    expect(StepSchema.safeParse({ ...makeProcedure().steps[0], provenance: 'guessed' }).success).toBe(false);
  });

  it('requires at least one effect per state variable', () => {
    expect(StateVarSchema.safeParse({ ...makeMachine().stateVars[0], effects: [] }).success).toBe(false);
  });

  it('rejects step indexes in links', () => {
    const link = { procedureSlug: 'scan', stepIndex: 0, label: 'Scan' };
    expect(StepLinkSchema.safeParse(link).success).toBe(false);
  });
});

describe('machine lookups', () => {
  it('returns clip references in first-seen order, excluding duplicates across effect lists', () => {
    const machine = makeMachine();
    machine.stateVars[0].effects.push(
      { type: 'clip', clip: 'OpenDoor' },
      { type: 'clip', clip: 'RaiseHead' },
      { type: 'clip', clip: 'OpenDoor' },
    );
    machine.stateVars[1].effects.push(
      { type: 'clip', clip: 'RaiseHead' },
      { type: 'clip', clip: 'LoadSample' },
    );
    expect(referencedClips(machine)).toEqual(['OpenDoor', 'RaiseHead', 'LoadSample']);
    expect(referencedClips(makeMachine())).toEqual([]);
  });

  it('ignores clip effects when collecting node references', () => {
    const machine = makeMachine();
    machine.stateVars[0].effects.push({ type: 'clip', clip: 'OpenDoor' });
    expect(referencedNodes(machine)).toEqual([
      'Park_NX10', 'head', 'z', 'sample', 'zCarriage', 'specimen',
    ]);
  });

  it('returns node references in first-seen order, excluding duplicates', () => {
    const machine = makeMachine();
    machine.stateVars[1].effects.push(
      { type: 'visible', node: 'Park_NX10' },
      { type: 'rotate', node: 'zCarriage', axis: 'z', angle: 1 },
      { type: 'visible', node: 'specimen' },
    );
    expect(referencedNodes(machine)).toEqual([
      'Park_NX10', 'head', 'z', 'sample', 'zCarriage', 'specimen',
    ]);
  });

  it('finds parts by node name and state variables by name', () => {
    const machine = makeMachine();
    expect(findPart(machine, 'head')).toBe(machine.parts[0]);
    expect(findStateVar(machine, 'lift')).toBe(machine.stateVars[0]);
    expect(findPart(machine, 'Head')).toBeUndefined();
    expect(findPart(machine, 'zCarriage')).toBeUndefined();
    expect(findStateVar(machine, 'Head raised')).toBeUndefined();
    expect(findStateVar(machine, 'unknown')).toBeUndefined();
  });
});

describe('procedure reference media', () => {
  it('accepts optional videos with or without a label alongside step images', () => {
    const content = makeProcedure();
    expect(ProcedureContentSchema.parse(content).video).toBeUndefined();
    for (const video of [
      { fileId: 'reference.mp4' },
      { fileId: 'storage-video-id', label: 'Watch the original demonstration' },
    ]) {
      content.video = video;
      content.steps[0].media = { fileId: 'media/step-01.jpg', alt: 'The raised head' };
      expect(ProcedureContentSchema.parse(content)).toEqual(content);
    }
  });

  it.each([
    {},
    { fileId: 42 },
    { fileId: 'reference.mp4', label: 42 },
    { fileId: 'reference.mp4', extra: true },
  ])('rejects malformed or unknown video fields: %j', (video) => {
    expect(ProcedureContentSchema.safeParse({ ...makeProcedure(), video }).success).toBe(false);
  });

  it('still requires alt text on step images', () => {
    const content = makeProcedure();
    expect(StepSchema.safeParse({
      ...content.steps[0], media: { fileId: 'media/step-01.png' },
    }).success).toBe(false);
  });
});

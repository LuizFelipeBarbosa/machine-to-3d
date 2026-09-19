import { describe, it, expect } from 'vitest';
import type { MachineDefinition } from './machine';
import type { ProcedureContent } from './procedure';
import { validateProcedure } from './validateProcedure';

const machine: MachineDefinition = {
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
      link: { procedureSlug: 'scan', stepId: 'align', label: 'Align the laser' },
    }],
  };
}

describe('validateProcedure', () => {
  it('accepts valid references', () => {
    expect(validateProcedure(makeProcedure(), machine, { scan: ['align'] })).toEqual([]);
  });

  it('reports unknown parts at their array position', () => {
    const content = makeProcedure();
    content.steps[0].parts.push('zCarriage');
    expect(validateProcedure(content, machine)).toEqual([
      { path: 'steps[0].parts[3]', message: expect.stringContaining('zCarriage') },
    ]);
  });

  it('reports unknown state variables', () => {
    const content = makeProcedure();
    content.steps[0].state = { laser: true };
    expect(validateProcedure(content, machine)).toEqual([
      { path: 'steps[0].state.laser', message: expect.stringContaining('laser') },
    ]);
  });

  it('reports every missing start key', () => {
    const content = makeProcedure();
    content.start = {};
    expect(validateProcedure(content, machine)).toEqual([
      { path: 'start.lift', message: expect.stringContaining('lift') },
      { path: 'start.sample', message: expect.stringContaining('sample') },
    ]);
  });

  it('reports every unknown start key', () => {
    const content = makeProcedure();
    content.start.laser = false;
    content.start.scanning = false;
    expect(validateProcedure(content, machine)).toEqual([
      { path: 'start.laser', message: expect.stringContaining('laser') },
      { path: 'start.scanning', message: expect.stringContaining('scanning') },
    ]);
  });

  it('reports duplicate step ids on the later occurrence', () => {
    const content = makeProcedure();
    content.steps.push({ ...content.steps[0] });
    expect(validateProcedure(content, machine)).toEqual([
      { path: 'steps[1].id', message: expect.stringContaining('raise') },
    ]);
  });

  it('requires at least one step', () => {
    const content = makeProcedure();
    content.steps = [];
    expect(validateProcedure(content, machine)).toEqual([
      { path: 'steps', message: expect.any(String) },
    ]);
  });

  it('reports an unknown link slug without checking its step id', () => {
    expect(validateProcedure(makeProcedure(), machine, {})).toEqual([
      { path: 'steps[0].link.procedureSlug', message: expect.stringContaining('scan') },
    ]);
  });

  it('reports a step id absent from the linked procedure', () => {
    expect(validateProcedure(makeProcedure(), machine, { scan: ['measure'] })).toEqual([
      { path: 'steps[0].link.stepId', message: expect.stringContaining('align') },
    ]);
  });

  it('allows a link to a procedure without specifying a step', () => {
    const content = makeProcedure();
    content.steps[0].link = { procedureSlug: 'scan', label: 'Scan' };
    expect(validateProcedure(content, machine, { scan: [] })).toEqual([]);
  });

  it('ignores links when link targets are omitted', () => {
    expect(validateProcedure(makeProcedure(), machine)).toEqual([]);
  });

  it('accepts a step without optional state or link', () => {
    const content = makeProcedure();
    delete content.steps[0].state;
    delete content.steps[0].link;
    expect(validateProcedure(content, machine, {})).toEqual([]);
  });

  it('does not treat inherited object keys as known link slugs', () => {
    const content = makeProcedure();
    content.steps[0].link = { procedureSlug: 'toString', label: 'Unknown procedure' };
    expect(validateProcedure(content, machine, {})).toEqual([
      { path: 'steps[0].link.procedureSlug', message: expect.stringContaining('toString') },
    ]);
  });

  it('collects independent issues together without mutating its inputs', () => {
    const content = makeProcedure();
    content.start = { extra: false };
    content.steps[0].parts = ['unknown'];
    content.steps[0].state = { unknown: true };
    const before = JSON.stringify({ content, machine });
    const issues = validateProcedure(content, machine, {});
    expect(issues.map((issue) => issue.path)).toEqual([
      'start.lift', 'start.sample', 'start.extra', 'steps[0].parts[0]',
      'steps[0].state.unknown', 'steps[0].link.procedureSlug',
    ]);
    expect(JSON.stringify({ content, machine })).toBe(before);
  });
});

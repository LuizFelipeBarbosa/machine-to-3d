import { describe, it, expect } from 'vitest';
import { ProcedureContentSchema } from './procedure';
import type { ProcedureContent } from './procedure';

function makeProcedure(): ProcedureContent {
  return {
    formatVersion: 1,
    title: 'Camera demonstration',
    summary: 'Move through the demonstration clip.',
    minutes: 2,
    start: { demo: 0, cover: true },
    steps: [{
      id: 'advance',
      title: 'Advance the demonstration',
      where: 'instrument',
      body: '',
      parts: [],
      view: { pos: [1, 1, 1], target: [0, 0, 0] },
      state: { demo: 0.18, cover: false },
    }],
  };
}

describe('numeric procedure state', () => {
  it.each([0, 0.18, 1])('parses numeric start and step values of %s alongside booleans', (value) => {
    const content = makeProcedure();
    content.start.demo = value;
    content.steps[0].state!.demo = value;
    expect(ProcedureContentSchema.parse(content)).toEqual(content);
  });

  it.each([-0.01, 1.01, NaN, Infinity, -Infinity])('rejects %s in start and step state', (value) => {
    const invalidStart = makeProcedure();
    invalidStart.start.demo = value;
    expect(ProcedureContentSchema.safeParse(invalidStart).success).toBe(false);

    const invalidStep = makeProcedure();
    invalidStep.steps[0].state!.demo = value;
    expect(ProcedureContentSchema.safeParse(invalidStep).success).toBe(false);
  });
});

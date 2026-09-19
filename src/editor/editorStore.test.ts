import { beforeEach, describe, expect, it } from 'vitest';
import type { MachineDefinition, View } from '../../shared/machine';
import type { ProcedureContent } from '../../shared/procedure';
import * as ops from './editorOps';
import { selectIssues, selectSelectedStep, useEditorStore } from './editorStore';
import type { EditorState } from './editorStore';

const view: View = { pos: [1, 2, 3], target: [0, 0, 0] };
const machine: MachineDefinition = {
  formatVersion: 1,
  rootNode: 'machine',
  parts: [
    { name: 'head', label: 'Head', blurb: 'The machine head.' },
    { name: 'z', label: 'Z stage', blurb: 'Raises the head.' },
  ],
  presetViews: [],
  stateVars: [
    {
      name: 'lift', label: 'Lift', kind: 'toggle',
      effects: [{ type: 'translate', node: 'head', offset: [0, 1, 0] }],
    },
    {
      name: 'covers', label: 'Covers', kind: 'toggle',
      effects: [{ type: 'visible', node: 'head' }],
    },
  ],
};

function makeContent(): ProcedureContent {
  return {
    formatVersion: 1,
    title: 'Prepare the machine',
    summary: 'Raise and lower the head.',
    minutes: 5,
    start: { lift: false, covers: true },
    steps: [
      {
        id: 'raise', title: 'Raise', where: 'instrument', body: '', parts: ['head'],
        view: structuredClone(view), state: { lift: true },
      },
      {
        id: 'uncover', title: 'Uncover', where: 'instrument', body: '', parts: ['z'],
        view: structuredClone(view), state: { covers: false },
      },
      {
        id: 'lower', title: 'Lower', where: 'instrument', body: '', parts: [],
        view: structuredClone(view), state: { lift: false },
      },
    ],
  };
}

const edits: { name: string; run: (store: EditorState) => void }[] = [
  { name: 'addStep', run: (store) => store.addStep('raise', view) },
  { name: 'removeStep', run: (store) => store.removeStep('uncover') },
  { name: 'moveStep', run: (store) => store.moveStep('raise', 1) },
  { name: 'patchStep', run: (store) => store.patchStep('raise', { title: 'Edited' }) },
  { name: 'togglePart', run: (store) => store.togglePart('raise', 'z') },
  { name: 'setStepState', run: (store) => store.setStepState('raise', 'lift', false) },
  { name: 'setStartState', run: (store) => store.setStartState('lift', true) },
  { name: 'patchMeta', run: (store) => store.patchMeta({ title: 'Edited' }) },
];

describe('editorStore', () => {
  beforeEach(() => {
    useEditorStore.setState(useEditorStore.getInitialState(), true);
  });

  it('loads content and machine context, selects the first step, and clears dirty', () => {
    const content = makeContent();
    const linkTargets = { other: ['start'] };
    useEditorStore.setState({ dirty: true, selectedStepId: 'old' });
    useEditorStore.getState().load({ content, machine, linkTargets });
    expect(useEditorStore.getState()).toMatchObject({
      content, machine, linkTargets, selectedStepId: 'raise', dirty: false,
    });
    expect(selectSelectedStep(useEditorStore.getState())).toBe(content.steps[0]);
  });

  it('loads an empty procedure without selecting a step', () => {
    useEditorStore.getState().load({ content: { ...makeContent(), steps: [] }, machine, linkTargets: {} });
    expect(useEditorStore.getState().selectedStepId).toBeNull();
    expect(selectSelectedStep(useEditorStore.getState())).toBeNull();
  });

  it.each(edits)('$name updates content and sets dirty without mutating loaded inputs', ({ run }) => {
    const content = makeContent();
    const before = structuredClone(content);
    useEditorStore.getState().load({ content, machine, linkTargets: {} });
    run(useEditorStore.getState());
    expect(useEditorStore.getState().dirty).toBe(true);
    expect(useEditorStore.getState().content).not.toStrictEqual(content);
    expect(content).toStrictEqual(before);
  });

  it.each(edits)('$name is harmless before loading content', ({ run }) => {
    const initial = useEditorStore.getState();
    run(initial);
    expect(useEditorStore.getState()).toBe(initial);
  });

  it('preserves numeric fraction values in start and step state and restores inheritance', () => {
    const fractionMachine = structuredClone(machine);
    fractionMachine.stateVars[0].kind = 'fraction';
    const content = makeContent();
    content.start.lift = 0;
    content.steps[0].state = { lift: 0 };
    content.steps[2].state = { lift: 0 };
    const store = useEditorStore.getState();
    store.load({ content, machine: fractionMachine, linkTargets: {} });

    store.setStartState('lift', 0.18);
    store.setStepState('raise', 'lift', 0.42);
    expect(useEditorStore.getState().content?.start.lift).toBe(0.18);
    expect(selectSelectedStep(useEditorStore.getState())?.state?.lift).toBe(0.42);
    expect(selectIssues(useEditorStore.getState())).toEqual([]);
    expect(useEditorStore.getState().dirty).toBe(true);

    store.setStepState('raise', 'lift', 0);
    expect(selectSelectedStep(useEditorStore.getState())?.state?.lift).toBe(0);
    store.setStepState('raise', 'lift', null);
    expect(selectSelectedStep(useEditorStore.getState())?.state).toBeUndefined();
    expect(ops.stateForStep(useEditorStore.getState().content!, 'raise').lift).toBe(0.18);
    expect(content.start.lift).toBe(0);
    expect(content.steps[0].state).toEqual({ lift: 0 });
  });

  it('selects and deselects without making content dirty', () => {
    const content = makeContent();
    const store = useEditorStore.getState();
    store.load({ content, machine, linkTargets: {} });
    store.select('uncover');
    expect(selectSelectedStep(useEditorStore.getState())).toBe(content.steps[1]);
    expect(useEditorStore.getState().dirty).toBe(false);
    store.select(null);
    expect(selectSelectedStep(useEditorStore.getState())).toBeNull();
    store.select('missing');
    expect(selectSelectedStep(useEditorStore.getState())).toBeNull();
  });

  it('selects the newly added step', () => {
    const store = useEditorStore.getState();
    store.load({ content: makeContent(), machine, linkTargets: {} });
    store.addStep('raise', view);
    const state = useEditorStore.getState();
    expect(state.selectedStepId).toBe(state.content?.steps[1].id);
    expect(selectSelectedStep(state)?.title).toBe('New step');
  });

  it('selects the next neighbour, then the previous one when deleting the last step', () => {
    const store = useEditorStore.getState();
    store.load({ content: makeContent(), machine, linkTargets: {} });
    store.select('uncover');
    store.removeStep('uncover');
    expect(useEditorStore.getState().selectedStepId).toBe('lower');
    store.removeStep('lower');
    expect(useEditorStore.getState().selectedStepId).toBe('raise');
    store.markSaved();
    const single = useEditorStore.getState().content;
    store.removeStep('raise');
    expect(useEditorStore.getState()).toMatchObject({
      content: single, selectedStepId: 'raise', dirty: true,
    });
    expect(useEditorStore.getState().content).toBe(single);
  });

  it('preserves selection when deleting another step or moving the selected step', () => {
    const store = useEditorStore.getState();
    store.load({ content: makeContent(), machine, linkTargets: {} });
    store.removeStep('uncover');
    expect(useEditorStore.getState().selectedStepId).toBe('raise');
    store.moveStep('raise', 1);
    expect(useEditorStore.getState().content?.steps.map((step) => step.id)).toEqual(['lower', 'raise']);
    expect(useEditorStore.getState().selectedStepId).toBe('raise');
  });

  it('marks even boundary edits dirty and clears dirty when saved', () => {
    const store = useEditorStore.getState();
    store.load({ content: makeContent(), machine, linkTargets: {} });
    store.moveStep('raise', -1);
    expect(useEditorStore.getState().dirty).toBe(true);
    const content = useEditorStore.getState().content;
    store.markSaved();
    expect(useEditorStore.getState().dirty).toBe(false);
    expect(useEditorStore.getState().content).toBe(content);
  });

  it('returns stable empty issues without content or a machine', () => {
    const initial = useEditorStore.getState();
    expect(selectIssues(initial)).toStrictEqual([]);
    expect(selectIssues(initial)).toBe(selectIssues(initial));
    expect(selectSelectedStep(initial)).toBeNull();
    useEditorStore.setState({ content: makeContent() });
    expect(selectIssues(useEditorStore.getState())).toStrictEqual([]);
  });

  it('validates content and reports an unknown part injected through editorOps', () => {
    const content = makeContent();
    useEditorStore.getState().load({ content, machine, linkTargets: {} });
    expect(selectIssues(useEditorStore.getState())).toStrictEqual([]);
    useEditorStore.setState({ content: ops.togglePart(content, 'raise', 'bad-part') });
    expect(selectIssues(useEditorStore.getState())).toStrictEqual([
      { path: 'steps[0].parts[1]', message: 'Unknown part "bad-part".' },
    ]);
  });

  it('reuses issues across selection changes and refreshes for machine or link targets', () => {
    const content = ops.patchStep(makeContent(), 'raise', {
      link: { procedureSlug: 'other', stepId: 'start', label: 'Other' },
    });
    const store = useEditorStore.getState();
    store.load({ content, machine, linkTargets: { other: ['start'] } });
    const issues = selectIssues(useEditorStore.getState());
    expect(issues).toStrictEqual([]);
    store.select('lower');
    expect(selectIssues(useEditorStore.getState())).toBe(issues);
    useEditorStore.setState({ linkTargets: { other: [] } });
    expect(selectIssues(useEditorStore.getState())).toStrictEqual([
      { path: 'steps[0].link.stepId', message: 'Unknown step "start" in procedure "other".' },
    ]);
    useEditorStore.setState({ machine: { ...machine, parts: [] }, linkTargets: { other: ['start'] } });
    expect(selectIssues(useEditorStore.getState()).map((issue) => issue.path))
      .toEqual(['steps[0].parts[0]', 'steps[1].parts[0]']);
  });
});

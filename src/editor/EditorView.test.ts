// @vitest-environment jsdom
import { createElement, StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import definition from '../../seed/park-nx10/machine.json';
import procedure from '../../seed/park-nx10/procedures/nc-scan.json';
import { MachineDefinitionSchema } from '../../shared/machine';
import type { View } from '../../shared/machine';
import { ProcedureContentSchema } from '../../shared/procedure';
import type { MachineRecord } from '../data/catalog';
import type { MachineSceneProps } from '../scene';
import { EditorView } from './EditorView';
import type { EditorViewProps } from './EditorView';
import { selectSelectedStep, useEditorStore } from './editorStore';

const camera = vi.hoisted(() => ({ goToView: vi.fn(), getCurrentView: vi.fn() }));
let sceneProps: MachineSceneProps;

vi.mock('../scene', async () => {
  const { createElement, forwardRef, useImperativeHandle } = await import('react');
  return {
    MachineScene: forwardRef((props: MachineSceneProps, ref) => {
      sceneProps = props;
      useImperativeHandle(ref, () => camera, []);
      return createElement('button', { onClick: () => props.onPickPart?.('xy') }, 'Pick XY stage');
    }),
  };
});

const machine: MachineRecord = {
  slug: 'park-nx10', name: 'Park NX10', kind: 'AFM', modelUrl: '/model.glb',
  definition: MachineDefinitionSchema.parse(definition),
};
const captured: View = { pos: [3.456, 4.567, 5.678], target: [0, 1.234, 0] };

function renderEditor(overrides: Partial<EditorViewProps> = {}) {
  return render(createElement(StrictMode, null, createElement(EditorView, {
    machine,
    procedureSlug: 'nc-scan',
    initialContent: ProcedureContentSchema.parse(procedure),
    linkTargets: { 'probe-exchange': ['probe-exchange-01'], shutdown: ['shutdown-01'] },
    procedureTitles: { 'probe-exchange': 'Probe exchange' },
    ...overrides,
  })));
}

beforeEach(() => {
  useEditorStore.setState(useEditorStore.getInitialState(), true);
  camera.goToView.mockReset();
  camera.getCurrentView.mockReset().mockReturnValue(captured);
});

afterEach(cleanup);

describe('procedure editor', () => {
  it('loads local content, folds inherited state, and leaves the orbit alone during edits', () => {
    renderEditor();
    expect(screen.getByText('Local demo: changes are not saved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(sceneProps.initialView).toEqual(procedure.steps[0].view);
    expect(useEditorStore.getState().dirty).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Align the beam on the cantilever/ }));
    expect(camera.goToView).toHaveBeenLastCalledWith(procedure.steps[4].view, { instant: false });
    expect(sceneProps.state.lift).toBe(true);
    const lift = screen.getByRole('group', { name: 'Head raised' });
    expect(within(lift).getByRole('button', { name: 'Inherit' }).getAttribute('aria-pressed')).toBe('true');
    expect(lift.parentElement?.textContent).toContain('inherits: on');

    camera.goToView.mockClear();
    fireEvent.change(screen.getByLabelText('Step title'), { target: { value: 'Align carefully' } });
    fireEvent.click(within(lift).getByRole('button', { name: 'On' }));
    expect(lift.parentElement?.textContent).toContain('same as inherited (no-op)');
    fireEvent.click(within(lift).getByRole('button', { name: 'Off' }));
    expect(sceneProps.state.lift).toBe(false);
    fireEvent.click(within(lift).getByRole('button', { name: 'Inherit' }));
    expect(sceneProps.state.lift).toBe(true);
    expect(selectSelectedStep(useEditorStore.getState())?.state?.lift).toBeUndefined();
    expect(camera.goToView).not.toHaveBeenCalled();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('toggles model parts and captures views only on request, including when adding a step', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Pick XY stage' }));
    expect(sceneProps.highlightedParts).toContain('xy');
    fireEvent.click(screen.getByRole('button', { name: 'Remove XY stage' }));
    expect(sceneProps.highlightedParts).not.toContain('xy');
    fireEvent.change(screen.getByLabelText('Add part by name'), { target: { value: 'xy' } });
    expect(sceneProps.highlightedParts).toContain('xy');

    const previousView = selectSelectedStep(useEditorStore.getState())?.view;
    fireEvent.change(screen.getByLabelText('Start from preset'), { target: { value: 'head' } });
    expect(camera.goToView).toHaveBeenLastCalledWith(machine.definition.presetViews[1].view);
    expect(selectSelectedStep(useEditorStore.getState())?.view).toEqual(previousView);
    camera.goToView.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Capture current view' }));
    expect(selectSelectedStep(useEditorStore.getState())?.view).toEqual(captured);
    expect(screen.getByText('3.46, 4.57, 5.68')).toBeTruthy();
    expect(camera.goToView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show this view' }));
    expect(camera.goToView).toHaveBeenLastCalledWith(captured);

    fireEvent.click(screen.getByRole('button', { name: '+ Add step after' }));
    const added = selectSelectedStep(useEditorStore.getState());
    expect(added?.view).toEqual(captured);
    expect(useEditorStore.getState().content?.steps[1]).toBe(added);
    fireEvent.click(screen.getByRole('button', { name: 'Move step 2 down' }));
    expect(useEditorStore.getState().content?.steps[2]?.id).toBe(added?.id);
    fireEvent.click(screen.getByRole('button', { name: 'Remove step 3' }));
    expect(useEditorStore.getState().content?.steps).toHaveLength(10);
    expect(selectSelectedStep(useEditorStore.getState())?.id).toBe(procedure.steps[2].id);
  });

  it('updates metadata and optional links immediately and navigates live reference issues', () => {
    const content = ProcedureContentSchema.parse(procedure);
    content.steps[4].parts.push('missing-part');
    renderEditor({ initialContent: content });
    fireEvent.click(screen.getByText('Procedure details'));
    fireEvent.change(screen.getByLabelText('Procedure title'), { target: { value: 'Edited procedure' } });
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Head raised' }));
    expect(useEditorStore.getState().content).toMatchObject({ title: 'Edited procedure', minutes: 30, start: { lift: true } });

    const issues = screen.getByRole('region', { name: 'Validation issues' });
    fireEvent.click(within(issues).getByRole('button', { name: /missing-part/ }));
    expect(selectSelectedStep(useEditorStore.getState())?.id).toBe(procedure.steps[4].id);
    fireEvent.click(screen.getByRole('button', { name: 'Remove missing-part' }));
    expect(within(issues).getByText('No issues')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Procedure', { exact: true }), { target: { value: 'probe-exchange' } });
    fireEvent.change(screen.getByLabelText('Linked step'), { target: { value: 'probe-exchange-01' } });
    fireEvent.change(screen.getByLabelText('Link label'), { target: { value: 'Change probe' } });
    expect(selectSelectedStep(useEditorStore.getState())?.link).toEqual({
      procedureSlug: 'probe-exchange', stepId: 'probe-exchange-01', label: 'Change probe',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(selectSelectedStep(useEditorStore.getState())?.link).toBeUndefined();
  });

  it('saves drafts with issues, preserves edits made during saving, and previews current content', async () => {
    let finishSave: () => void = () => {};
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const onPreview = vi.fn();
    renderEditor({ onSave, onPreview });
    expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => useEditorStore.getState().togglePart(procedure.steps[0].id, 'missing-part'));
    expect(screen.getByText('1 validation issue')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(onSave).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText('Step title'), { target: { value: 'Changed during save' } });
    await act(async () => finishSave());
    expect(useEditorStore.getState().dirty).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(onPreview).toHaveBeenCalledWith(useEditorStore.getState().content);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await act(async () => finishSave());
    expect(useEditorStore.getState().dirty).toBe(false);
  });

  it('keeps failed saves dirty and reports the error', async () => {
    renderEditor({ onSave: async () => { throw new Error('Save failed'); } });
    fireEvent.change(screen.getByLabelText('Step title'), { target: { value: 'Edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Save failed');
    expect(useEditorStore.getState().dirty).toBe(true);
  });
});

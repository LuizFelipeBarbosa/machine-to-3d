// @vitest-environment jsdom
import { StrictMode, createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineDefinitionSchema } from '../../shared/machine';
import definition from '../../seed/park-nx10/machine.json';
import type { MachineRecord, ProcedureRecord } from '../data/catalog';
import type { SceneController } from '../machine/useSceneController';
import { PlayerPanel } from './PlayerPanel';
import { usePlayerStore } from './playerStore';

const camera = { goToView: vi.fn(), getCurrentView: vi.fn(), resetView: vi.fn() };
const controller: SceneController = {
  handle: { current: camera }, state: {}, setState: vi.fn(), highlighted: [], setHighlighted: vi.fn(),
};

const machine: MachineRecord = {
  slug: 'test-machine', name: 'Test machine', kind: 'Instrument', modelUrl: '/model.glb',
  definition: MachineDefinitionSchema.parse(definition),
};
const procedure: ProcedureRecord = {
  slug: 'test-procedure', machineSlug: machine.slug, placeholder: false,
  content: {
    formatVersion: 1, title: 'Test procedure', summary: '', minutes: 1, start: {},
    steps: [{
      id: 'confirm', title: 'Confirm setup', where: 'instrument', body: '', parts: [],
      view: { pos: [1, 1, 1], target: [0, 0, 0] }, check: 'Setup is ready',
    }],
  },
};
const progressKey = `${machine.slug}/${procedure.slug}`;

beforeEach(() => {
  vi.clearAllMocks();
  controller.handle.current = camera;
  usePlayerStore.setState({ progress: {} });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  Element.prototype.scrollIntoView = vi.fn();
});

describe('scene synchronization', () => {
  it('waits for the Canvas handle and uses an instant view only for the first step shown', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => frames.push(callback)));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    controller.handle.current = null;
    const withTwoSteps: ProcedureRecord = {
      ...procedure,
      content: {
        ...procedure.content,
        steps: [
          procedure.content.steps[0],
          { ...procedure.content.steps[0], id: 'next', title: 'Next task', view: { pos: [2, 2, 2], target: [0, 0, 0] } },
        ],
      },
    };
    const props = { controller, machine, procedure: withTwoSteps, linkTargets: {}, onOpenProcedure: vi.fn() };
    const view = render(createElement(PlayerPanel, props));
    expect(camera.goToView).not.toHaveBeenCalled();
    controller.handle.current = camera;
    act(() => frames[0](0));
    expect(camera.goToView).toHaveBeenCalledExactlyOnceWith(procedure.content.steps[0].view, { instant: true });

    view.rerender(createElement(PlayerPanel, { ...props, initialStepId: 'next' }));
    expect(camera.goToView).toHaveBeenLastCalledWith(withTwoSteps.content.steps[1].view, { instant: false });
    camera.goToView.mockClear();
    view.unmount();
    expect(controller.setHighlighted).toHaveBeenLastCalledWith([]);
    expect(camera.goToView).not.toHaveBeenCalled();
  });

  it('cancels a pending camera synchronization when the panel unmounts', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 123));
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    controller.handle.current = null;
    const view = render(createElement(PlayerPanel, {
      controller, machine, procedure, linkTargets: {}, onOpenProcedure: vi.fn(),
    }));
    view.unmount();
    expect(cancel).toHaveBeenCalledWith(123);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('completion reporting', () => {
  it('previews from the first step without reading, persisting, or recording training progress', () => {
    const recordedProgress = { cur: 1, checked: ['confirm'], done: ['confirm'] };
    usePlayerStore.setState({ progress: { [progressKey]: recordedProgress } });
    const onComplete = vi.fn();
    render(createElement(PlayerPanel, {
      controller, machine, procedure, linkTargets: {}, onOpenProcedure: vi.fn(), onComplete, preview: true,
    }));
    expect(screen.getByText('Draft preview — not recorded')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: /Setup is ready/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: /Setup is ready/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish procedure' }));
    expect(screen.getByRole('heading', { name: 'Procedure complete' })).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().progress[progressKey]).toEqual(recordedProgress);
  });

  it('renders stored media URLs and preserves URL-based local images', () => {
    const withMedia: ProcedureRecord = {
      ...procedure,
      content: {
        ...procedure.content,
        steps: [{ ...procedure.content.steps[0], media: { fileId: 'storage-id', alt: 'Scan settings' } }],
      },
    };
    const props = { controller, machine, procedure: withMedia, linkTargets: {}, onOpenProcedure: vi.fn() };
    const view = render(createElement(PlayerPanel, { ...props, mediaUrls: { 'storage-id': '/screenshot.png' } }));
    expect(screen.getByRole('img', { name: 'Scan settings' }).getAttribute('src')).toBe('/screenshot.png');
    withMedia.content.steps[0].media = { fileId: '/local.png', alt: 'Local screenshot' };
    view.rerender(createElement(PlayerPanel, props));
    expect(screen.getByRole('img', { name: 'Local screenshot' }).getAttribute('src')).toBe('/local.png');
  });

  it('reports checked steps once, ignores revisiting completion, and allows another run after restart', () => {
    const onComplete = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    const props = { controller, machine, procedure, linkTargets: {}, onOpenProcedure: vi.fn(), onComplete };
    const view = render(createElement(StrictMode, null, createElement(PlayerPanel, props)));

    fireEvent.click(screen.getByRole('button', { name: 'Finish procedure' }));
    expect(onComplete).not.toHaveBeenCalled();
    act(() => usePlayerStore.getState().setChecked(progressKey, 'confirm', true));
    fireEvent.click(screen.getByRole('button', { name: 'Finish procedure' }));
    expect(onComplete).toHaveBeenCalledExactlyOnceWith([{ stepId: 'confirm', at: 123456 }]);

    const replacement = vi.fn();
    view.rerender(createElement(StrictMode, null, createElement(PlayerPanel, { ...props, onComplete: replacement })));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish procedure' }));
    expect(replacement).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    act(() => usePlayerStore.getState().setChecked(progressKey, 'confirm', true));
    fireEvent.click(screen.getByRole('button', { name: 'Finish procedure' }));
    expect(replacement).toHaveBeenCalledExactlyOnceWith([{ stepId: 'confirm', at: 123456 }]);
  });

  it('reports restored completed progress only once under Strict Mode', () => {
    usePlayerStore.setState({ progress: { [progressKey]: { cur: 1, checked: ['confirm'], done: ['confirm'] } } });
    const onComplete = vi.fn();
    render(createElement(StrictMode, null, createElement(PlayerPanel, {
      controller, machine, procedure, linkTargets: {}, onOpenProcedure: vi.fn(), onComplete,
    })));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete.mock.calls[0][0]).toEqual([{ stepId: 'confirm', at: expect.any(Number) }]);
  });
});

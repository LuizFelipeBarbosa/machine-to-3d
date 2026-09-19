// @vitest-environment jsdom
import { StrictMode, createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineDefinitionSchema } from '../../shared/machine';
import definition from '../../seed/park-nx10/machine.json';
import type { MachineRecord, ProcedureRecord } from '../data/catalog';
import { PlayerView } from './PlayerView';
import { usePlayerStore } from './playerStore';

vi.mock('../scene', () => ({ MachineScene: () => null }));

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
  usePlayerStore.setState({ progress: {} });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  Element.prototype.scrollIntoView = vi.fn();
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
    render(createElement(PlayerView, {
      machine, procedure, linkTargets: {}, onOpenProcedure: vi.fn(), onComplete, preview: true,
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
    const props = { machine, procedure: withMedia, linkTargets: {}, onOpenProcedure: vi.fn() };
    const view = render(createElement(PlayerView, { ...props, mediaUrls: { 'storage-id': '/screenshot.png' } }));
    expect(screen.getByRole('img', { name: 'Scan settings' }).getAttribute('src')).toBe('/screenshot.png');
    withMedia.content.steps[0].media = { fileId: '/local.png', alt: 'Local screenshot' };
    view.rerender(createElement(PlayerView, props));
    expect(screen.getByRole('img', { name: 'Local screenshot' }).getAttribute('src')).toBe('/local.png');
  });

  it('reports checked steps once, ignores revisiting completion, and allows another run after restart', () => {
    const onComplete = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    const props = { machine, procedure, linkTargets: {}, onOpenProcedure: vi.fn(), onComplete };
    const view = render(createElement(StrictMode, null, createElement(PlayerView, props)));

    fireEvent.click(screen.getByRole('button', { name: 'Finish procedure' }));
    expect(onComplete).not.toHaveBeenCalled();
    act(() => usePlayerStore.getState().setChecked(progressKey, 'confirm', true));
    fireEvent.click(screen.getByRole('button', { name: 'Finish procedure' }));
    expect(onComplete).toHaveBeenCalledExactlyOnceWith([{ stepId: 'confirm', at: 123456 }]);

    const replacement = vi.fn();
    view.rerender(createElement(StrictMode, null, createElement(PlayerView, { ...props, onComplete: replacement })));
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
    render(createElement(StrictMode, null, createElement(PlayerView, {
      machine, procedure, linkTargets: {}, onOpenProcedure: vi.fn(), onComplete,
    })));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete.mock.calls[0][0]).toEqual([{ stepId: 'confirm', at: expect.any(Number) }]);
  });
});

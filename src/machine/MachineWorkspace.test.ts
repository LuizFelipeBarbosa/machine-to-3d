// @vitest-environment jsdom
import { createElement, StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineDefinitionSchema } from '../../shared/machine';
import definition from '../../seed/park-nx10/machine.json';
import { CatalogProvider } from '../data/CatalogContext';
import type { MachineRecord, ProcedureRecord } from '../data/catalog';
import { usePlayerStore } from '../player/playerStore';
import type { MachineSceneProps } from '../scene';
import { MachineWorkspace } from './MachineWorkspace';

const scene = vi.hoisted(() => ({
  mounts: 0,
  goToView: vi.fn(),
  getCurrentView: vi.fn(),
  resetView: vi.fn(),
}));
let sceneProps: MachineSceneProps;
const debugWindow = window as Window & { __sceneMounts?: number };

vi.mock('../data/mode', () => ({ isConvexMode: false }));
vi.mock('../scene', async () => {
  const { createElement, forwardRef, useEffect, useImperativeHandle, useRef } = await import('react');
  return {
    MachineScene: forwardRef((props: MachineSceneProps, ref) => {
      sceneProps = props;
      const counted = useRef(false);
      useEffect(() => {
        if (!counted.current) scene.mounts += 1;
        counted.current = true;
      }, []);
      useImperativeHandle(ref, () => scene, []);
      return createElement('div', { className: 'machine-scene' },
        createElement('canvas'),
        createElement('button', { onClick: () => props.onPickPart?.('xy') }, 'Pick XY stage'),
      );
    }),
  };
});

const machine: MachineRecord = {
  slug: 'machine', name: 'Test machine', kind: 'Instrument', modelUrl: '/model.glb',
  definition: MachineDefinitionSchema.parse(definition),
};
const first: ProcedureRecord = {
  slug: 'first', machineSlug: machine.slug, placeholder: false,
  content: {
    formatVersion: 1, title: 'First procedure', summary: 'Start here.', minutes: 2,
    start: { lift: false, internals: true },
    steps: [
      {
        id: 'start', title: 'Start setup', body: '', where: 'instrument', parts: ['head'],
        view: { pos: [1, 1, 1], target: [0, 0, 0] }, check: 'Ready to start',
        link: { procedureSlug: 'first', stepId: 'finish', label: 'Jump to finish' },
      },
      {
        id: 'finish', title: 'Finish setup', body: '', where: 'instrument', parts: ['xy'], state: { lift: true },
        view: { pos: [2, 2, 2], target: [0, 0, 0] },
        link: { procedureSlug: 'second', stepId: 'target', label: 'Open second target' },
      },
    ],
  },
};
const second: ProcedureRecord = {
  ...first, slug: 'second',
  content: {
    ...first.content, title: 'Second procedure',
    steps: [
      { ...first.content.steps[0], check: undefined, link: undefined },
      { ...first.content.steps[1], id: 'target', title: 'Linked target', link: undefined },
    ],
  },
};
const catalog = {
  getMachine: vi.fn(async () => machine),
  listMachines: vi.fn(async () => [{
    ...machine,
    procedures: [first, second].map(({ slug, content }) => ({ slug, title: content.title, minutes: content.minutes })),
  }]),
  getProcedure: vi.fn(async (_machine: string, slug: string): Promise<ProcedureRecord | null> => (
    slug === first.slug ? first : slug === second.slug ? second : null
  )),
  listStepIds: vi.fn(async () => ({ first: ['start', 'finish'], second: ['start', 'target'] })),
};

function app(path = '/m/machine', strict = false) {
  window.history.replaceState(null, '', path);
  const tree = createElement(BrowserRouter, null,
    createElement(CatalogProvider, { catalog, children:
      createElement(Routes, null,
        createElement(Route, { path: '/m/:machine/:procedure?', element: createElement(MachineWorkspace) }),
      ),
    }),
  );
  return render(strict ? createElement(StrictMode, null, tree) : tree);
}

function selectProcedure(slug: string) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Procedure' }), { target: { value: slug } });
}

beforeEach(() => {
  vi.clearAllMocks();
  scene.mounts = 0;
  debugWindow.__sceneMounts = 0;
  usePlayerStore.setState({ progress: {} });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete debugWindow.__sceneMounts;
});

describe('machine workspace', () => {
  it('keeps one scene through selection, procedure links, cached returns, and exploration', async () => {
    const view = app();
    await screen.findByRole('button', { name: 'Reset view' });
    const canvas = view.container.querySelector('canvas');
    const initialDefinition = sceneProps.definition;
    expect(sceneProps.initialView).toBeUndefined();
    expect(screen.getAllByRole('heading', { name: machine.name })).toHaveLength(1);

    selectProcedure('first');
    await screen.findByText('Start setup');
    expect(scene.goToView).toHaveBeenLastCalledWith(first.content.steps[0].view, { instant: true });
    expect(window.location.pathname).toBe('/m/machine/first');
    fireEvent.click(screen.getByRole('checkbox', { name: /Ready to start/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }));
    expect(sceneProps.state.lift).toBe(true);
    expect(scene.goToView).toHaveBeenLastCalledWith(first.content.steps[1].view, { instant: false });
    expect(view.container.querySelector('[aria-live]')?.textContent).toBe('Step 2 of 2: Finish setup');

    fireEvent.click(screen.getByRole('button', { name: 'Open second target' }));
    await screen.findByText('Linked target');
    expect(window.location.pathname + window.location.search).toBe('/m/machine/second?step=target');
    expect(view.container.querySelector('.panel-count')?.textContent).toBe('Step 2 of 2');
    expect(scene.goToView).toHaveBeenLastCalledWith(second.content.steps[1].view, { instant: true });

    selectProcedure('first');
    expect(screen.queryByText('Loading procedure…')).toBeNull();
    expect(view.container.querySelector('.step.is-current .step-title')?.textContent).toBe('Finish setup');
    expect(sceneProps.highlightedParts).toEqual(['xy']);
    expect(sceneProps.definition).toBe(initialDefinition);
    scene.goToView.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Explore the machine' }));
    expect(window.location.pathname).toBe('/m/machine');
    expect(sceneProps.state.lift).toBe(true);
    expect(sceneProps.highlightedParts).toEqual([]);
    expect(scene.goToView).not.toHaveBeenCalled();
    expect(view.container.querySelector('canvas')).toBe(canvas);
    expect(scene.mounts).toBe(1);
    expect(debugWindow.__sceneMounts).toBe(1);
    expect(catalog.getMachine).toHaveBeenCalledOnce();
    expect(catalog.listMachines).toHaveBeenCalledOnce();
    expect(catalog.getProcedure).toHaveBeenCalledTimes(2);
    expect(catalog.listStepIds).toHaveBeenCalledTimes(2);
  });

  it('keeps the scene mounted under Strict Mode and resets the camera through its handle', async () => {
    app('/m/machine', true);
    await screen.findByRole('button', { name: 'Reset view' });
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    expect(scene.goToView).toHaveBeenCalledWith(machine.definition.presetViews[0].view);
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(scene.resetView).toHaveBeenCalledOnce();
    selectProcedure('first');
    await screen.findByText('Start setup');
    selectProcedure('');
    expect(scene.mounts).toBe(1);
    expect(debugWindow.__sceneMounts).toBe(1);
    expect(catalog.getMachine).toHaveBeenCalledOnce();
    expect(catalog.listMachines).toHaveBeenCalledOnce();
  });

  it('supports inspecting parts, user toggles, checkpoint keys, and step links within the selected procedure', async () => {
    const view = app('/m/machine/first');
    await screen.findByText('Start setup');
    expect(screen.queryByRole('checkbox', { name: 'Head raised' })).toBeNull();
    const userToggle = machine.definition.stateVars.find((variable) => variable.userToggle)!;
    const toggle = screen.getByRole('checkbox', { name: userToggle.label }) as HTMLInputElement;
    const wasChecked = toggle.checked;
    scene.goToView.mockClear();
    fireEvent.click(toggle);
    expect(sceneProps.state[userToggle.name]).toBe(!wasChecked);
    expect(scene.goToView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to step view' }));
    expect(scene.goToView).toHaveBeenLastCalledWith(first.content.steps[0].view, { instant: false });

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(view.container.querySelector('.panel-count')?.textContent).toBe('Step 1 of 2');
    fireEvent.click(screen.getByRole('checkbox', { name: /Ready to start/ }));
    const picker = screen.getByRole('combobox', { name: 'Procedure' });
    picker.focus();
    fireEvent.keyDown(picker, { key: 'ArrowRight' });
    expect(view.container.querySelector('.panel-count')?.textContent).toBe('Step 1 of 2');
    picker.blur();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(view.container.querySelector('.panel-count')?.textContent).toBe('Step 2 of 2');
    expect(sceneProps.state[userToggle.name]).toBe(!wasChecked);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });

    fireEvent.click(screen.getByRole('button', { name: 'Pick XY stage' }));
    expect(view.container.querySelector('.inspect')?.textContent).toContain('Used in step');
    expect(sceneProps.highlightedParts).toEqual(['head', 'xy']);
    fireEvent.click(screen.getByRole('button', { name: 'Go to step 2' }));
    expect(view.container.querySelector('.inspect')).toBeNull();
    expect(sceneProps.highlightedParts).toEqual(['xy']);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Jump to finish' }));
    expect(window.location.search).toBe('?step=finish');
    expect(view.container.querySelector('.panel-count')?.textContent).toBe('Step 2 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Jump to finish' }));
    expect(view.container.querySelector('.panel-count')?.textContent).toBe('Step 2 of 2');
    expect(scene.mounts).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Pick XY stage' }));
    selectProcedure('');
    expect(view.container.querySelector('.inspect')).toBeNull();
    expect(sceneProps.highlightedParts).toEqual([]);
    expect(screen.getAllByRole('checkbox')).toHaveLength(machine.definition.stateVars.length);
    fireEvent.click(screen.getByRole('button', { name: /^AFM head/ }));
    expect(view.container.querySelector('.inspect')?.textContent).toContain('AFM head');
    expect(view.container.querySelector('.uses')).toBeNull();
  });

  it('keeps the viewport while loading another procedure and ignores late results', async () => {
    let finishLoad: (procedure: ProcedureRecord | null) => void = () => {};
    catalog.getProcedure.mockImplementationOnce(() => new Promise((resolve) => { finishLoad = resolve; }));
    const view = app();
    await screen.findByRole('button', { name: 'Reset view' });
    const canvas = view.container.querySelector('canvas');
    selectProcedure('first');
    expect(screen.getByText('Loading procedure…')).toBeTruthy();
    selectProcedure('second');
    await screen.findByText('Linked target');
    await act(async () => finishLoad(first));
    expect(screen.getByRole('option', { name: 'Second procedure · 2 min' })).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Procedure' }) as HTMLSelectElement).value).toBe('second');
    selectProcedure('first');
    expect(screen.queryByText('Loading procedure…')).toBeNull();
    expect(view.container.querySelector('canvas')).toBe(canvas);
    expect(scene.mounts).toBe(1);
  });

  it('keeps the scene available after a procedure load fails', async () => {
    catalog.getProcedure.mockRejectedValueOnce(new Error('Unavailable'));
    const view = app('/m/machine/first');
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to load procedure: Unavailable');
    const canvas = view.container.querySelector('canvas');
    selectProcedure('second');
    await screen.findByText('Linked target');
    expect(view.container.querySelector('canvas')).toBe(canvas);
    expect(scene.mounts).toBe(1);
  });
});

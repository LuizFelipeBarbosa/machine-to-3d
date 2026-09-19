// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { MachineDefinition } from '../../shared/machine';
import { useGlbCheck } from './useGlbCheck';

afterEach(cleanup);

const definition: MachineDefinition = {
  formatVersion: 1,
  rootNode: 'Root',
  parts: [{ name: 'Door', label: 'Door', blurb: '' }],
  presetViews: [],
  stateVars: [{ name: 'open', label: 'Open', kind: 'toggle', effects: [{ type: 'translate', node: 'Door', offset: [1, 0, 0] }] }],
};

function glbFile(roots: number[], names: string[]): File {
  const json = JSON.stringify({ scenes: [{ nodes: roots }], nodes: names.map((name) => ({ name })) });
  const chunk = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const bytes = new ArrayBuffer(20 + chunk.length);
  const header = new DataView(bytes);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, bytes.byteLength, true);
  header.setUint32(12, chunk.length, true);
  header.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20).set(chunk);
  return Object.assign(new File([], 'model.glb'), { arrayBuffer: async () => bytes });
}

it('checks roots, parts, and effect nodes against a real GLB summary', async () => {
  const file = glbFile([0], ['Root', 'Door']);
  const { result, rerender } = renderHook(({ definition }) => useGlbCheck(file, definition), {
    initialProps: { definition },
  });
  await waitFor(() => expect(result.current.summary?.rootNodes).toEqual(['Root']));
  expect(result.current.issues).toEqual([]);

  rerender({ definition: { ...definition, rootNode: 'Other', stateVars: [
    { ...definition.stateVars[0], effects: [{ type: 'visible', node: 'Missing' }] },
  ] } });
  expect(result.current.issues.join(' ')).toContain('rootNode: expected "Other"');
  expect(result.current.issues.join(' ')).toContain('Referenced node "Missing" is missing');
});

it.each([{ roots: [] }, { roots: [0, 1] }])('rejects a GLB with roots $roots', async ({ roots }) => {
  const file = glbFile(roots, ['Root', 'Door']);
  const { result } = renderHook(() => useGlbCheck(file, definition));
  await waitFor(() => expect(result.current.issues.join(' ')).toContain('exactly one root'));
});

it('ignores a replaced file that finishes reading late', async () => {
  let finishRead: (bytes: ArrayBuffer) => void = () => {};
  const oldFile = Object.assign(new File([], 'old.glb'), {
    arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; }),
  });
  const { result, rerender } = renderHook(({ file }) => useGlbCheck(file, definition), {
    initialProps: { file: oldFile as File },
  });
  const nextFile = glbFile([0], ['Root', 'Door']);
  rerender({ file: nextFile });
  expect(result.current.summary).toBeNull();
  await waitFor(() => expect(result.current.issues).toEqual([]));
  await act(async () => { finishRead(new ArrayBuffer(0)); });
  expect(result.current.summary?.rootNodes).toEqual(['Root']);
  expect(result.current.issues).toEqual([]);
});

it('reports unreadable GLB data', async () => {
  const file = Object.assign(new File([], 'broken.glb'), { arrayBuffer: async () => new ArrayBuffer(0) });
  const { result } = renderHook(() => useGlbCheck(file, definition));
  await waitFor(() => expect(result.current.issues.join(' ')).toContain('Invalid GLB'));
  expect(result.current.summary).toBeNull();
});

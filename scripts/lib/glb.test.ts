import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nodeBounds, parseGlbJson, summarizeGlb } from './glb.js';

function makeGlb(document: unknown): Uint8Array {
  const json = Buffer.from(JSON.stringify(document));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(20 + paddedLength, 0x20);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(paddedLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  json.copy(bytes, 20);
  return bytes;
}

describe('reference instrument GLBs', () => {
  it('reports the RISE animation duration and named targets', async () => {
    const bytes = await readFile(new URL('../../seed/rise-raman-sem/model.glb', import.meta.url));
    const summary = summarizeGlb(bytes);
    expect(summary.animations).toHaveLength(1);
    expect(summary.animations[0].duration).toBeGreaterThan(0);
    expect(summary.animations[0].targetNodes.length).toBeGreaterThan(0);
    for (const name of summary.animations[0].targetNodes) {
      expect(summary.namedNodes).toContain(name);
    }
  });

  it('reports no animations for the Park NX10', async () => {
    const bytes = await readFile(new URL('../../seed/park-nx10/model.glb', import.meta.url));
    expect(summarizeGlb(bytes).animations).toEqual([]);
  });

  it('bounds the PE25 door within a strictly larger model', async () => {
    const bytes = await readFile(new URL('../../seed/plasma-etch-pe25/model.glb', import.meta.url));
    const door = nodeBounds(bytes, ['door']);
    const model = summarizeGlb(bytes).boundingBox!;
    expect(door).not.toBeNull();
    for (let axis = 0; axis < 3; axis++) {
      expect(door!.min[axis]).toBeGreaterThanOrEqual(model.min[axis]);
      expect(door!.max[axis]).toBeLessThanOrEqual(model.max[axis]);
    }
    expect(door!.max.some((value, axis) => value - door!.min[axis] < model.max[axis] - model.min[axis])).toBe(true);
    expect(nodeBounds(bytes, ['unknown-node'])).toBeNull();
  });

  it('bounds the Park NX10 head and its probe within the model', async () => {
    const bytes = await readFile(new URL('../../seed/park-nx10/model.glb', import.meta.url));
    const bounds = nodeBounds(bytes);
    const model = summarizeGlb(bytes).boundingBox!;
    expect(bounds.head).toBeDefined();
    expect(bounds.probe).toBeDefined();
    const height = bounds.head.max[1] - bounds.head.min[1];
    expect(height).toBeGreaterThan(0.5);
    expect(height).toBeLessThan(2);
    for (let axis = 0; axis < 3; axis++) {
      expect(bounds.head.min[axis]).toBeGreaterThanOrEqual(model.min[axis]);
      expect(bounds.head.max[axis]).toBeLessThanOrEqual(model.max[axis]);
      expect(bounds.probe.min[axis]).toBeGreaterThanOrEqual(bounds.head.min[axis]);
      expect(bounds.probe.max[axis]).toBeLessThanOrEqual(bounds.head.max[axis]);
    }
  });

  it.each([
    {
      file: 'rise-raman-sem',
      root: 'RISE_Raman_SEM',
      height: 7.26,
      animationCount: 1,
      namedNodes: [
        'base', 'chamber', 'column', 'raman', 'cart', 'spectrometer', 'cables',
        'SEM_access_door', 'interior', 'sample', 'detectors',
      ],
    },
    {
      file: 'park-nx10',
      root: 'Park_NX10',
      height: 5.97,
      animationCount: 0,
      namedNodes: [
        'optics', 'head', 'sample', 'xy', 'z', 'focus', 'covers', 'probe',
        'specimen', 'zCarriage',
      ],
    },
  ])('summarizes $file', async ({ file, root, height, animationCount, namedNodes }) => {
    const bytes = await readFile(new URL(`../../seed/${file}/model.glb`, import.meta.url));
    const summary = summarizeGlb(bytes);
    expect(summary.generator).toMatch(/^THREE\.GLTFExporter\b/);
    expect(summary.rootNodes).toEqual([root]);
    expect(summary.animationCount).toBe(animationCount);
    expect(summary.extensionsUsed).toContain('KHR_materials_unlit');
    expect(summary.namedNodes).toEqual(expect.arrayContaining(namedNodes));
    expect(summary.duplicateNames).toEqual([]);
    expect(summary.boundingBox).not.toBeNull();
    const bounds = summary.boundingBox!;
    expect(Math.abs(bounds.max[1] - bounds.min[1] - height)).toBeLessThanOrEqual(0.05);
  });
});

describe('GLB parsing and bounds', () => {
  it('summarizes all sampler durations and unique named targets in channel order', () => {
    const summary = summarizeGlb(makeGlb({
      nodes: [{ name: 'first' }, {}, { name: 'second' }, { name: 'first' }],
      accessors: [{ max: [2] }, { max: [5] }, {}],
      animations: [
        {
          name: 'open',
          samplers: [{ input: 0 }, { input: 1 }, { input: 2 }, { input: 99 }],
          channels: [2, 1, 0, 2, 3, undefined].map(node => ({ target: { node, path: 'translation' } })),
        },
        { samplers: [{ input: 2 }], channels: [] },
        { samplers: [], channels: [] },
      ],
    }));
    expect(summary.animations).toEqual([
      { name: 'open', duration: 5, targetNodes: ['second', 'first'] },
      { name: '', duration: 0, targetNodes: [] },
      { name: '', duration: 0, targetNodes: [] },
    ]);
    expect(summary.animationCount).toBe(3);
  });

  it('validates required clips and prints animation details in the CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'inspect-glb-'));
    try {
      const file = join(directory, 'animations.glb');
      await writeFile(file, makeGlb({
        scenes: [{ nodes: [0] }],
        nodes: [{ name: 'root', children: [1] }, { name: 'door' }],
        accessors: [{ max: [2] }],
        animations: [
          {
            name: 'open', samplers: [{ input: 0 }],
            channels: [{ target: { node: 1, path: 'rotation' } }, { target: { node: 0, path: 'translation' } }],
          },
          { name: 'close', samplers: [], channels: [] },
        ],
      }));
      const script = fileURLToPath(new URL('../inspect-glb.ts', import.meta.url));
      const success = spawnSync(process.execPath, [
        '--import', 'tsx', script, file, '--require-clip', ' open, close ',
      ], { encoding: 'utf8' });
      expect(success.error).toBeUndefined();
      expect(success.status).toBe(0);
      expect(success.stdout).toContain('animations: 2\n  open: 2s → door, root\n  close: 0s → \n');

      const failure = spawnSync(process.execPath, [
        '--import', 'tsx', script, file, '--require-clip', 'open,nope,missing',
      ], { encoding: 'utf8' });
      expect(failure.error).toBeUndefined();
      expect(failure.status).toBe(1);
      expect(failure.stderr).toBe('inspect-glb: Missing required animation clips: nope, missing.\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a duplicate name for meshless nodes', () => {
    const summary = summarizeGlb(makeGlb({
      asset: { version: '2.0' },
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ name: 'x' }, { name: 'x' }],
    }));
    expect(summary.duplicateNames).toEqual(['x']);
  });

  it('reports every duplicate name once in alphabetical order', () => {
    const summary = summarizeGlb(makeGlb({
      nodes: ['z', 'a', 'z', 'unique', 'a', 'z', '', ''].map(name => ({ name })),
    }));
    expect(summary.duplicateNames).toEqual(['a', 'z']);
  });

  it('makes inspect-glb list duplicate names and exit with status 1', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'inspect-glb-'));
    try {
      const file = join(directory, 'duplicates.glb');
      await writeFile(file, makeGlb({
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }],
        nodes: [
          { name: 'root', children: [1, 2, 3, 4] },
          { name: 'b' }, { name: 'a' }, { name: 'b' }, { name: 'a' },
        ],
      }));
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', fileURLToPath(new URL('../inspect-glb.ts', import.meta.url)), file,
      ], { encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('inspect-glb: Duplicate node names: a, b.');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects wrong magic', () => {
    const bytes = makeGlb({});
    bytes[0] = 0;
    expect(() => parseGlbJson(bytes)).toThrow(/magic/i);
  });

  it('rejects unsupported versions and missing JSON', () => {
    const bytes = makeGlb({});
    bytes[4] = 1;
    expect(() => parseGlbJson(bytes)).toThrow(/version/i);
    bytes[4] = 2;
    bytes[16] = 0;
    expect(() => parseGlbJson(bytes)).toThrow(/missing JSON/i);
  });

  it('handles buffer offsets and rejects truncated chunks', () => {
    const bytes = makeGlb({ asset: { version: '2.0' } });
    const padded = Buffer.concat([Buffer.alloc(7), bytes, Buffer.alloc(3)]);
    expect(parseGlbJson(padded.subarray(7, 7 + bytes.length))).toEqual({ asset: { version: '2.0' } });
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(12, bytes.length, true);
    expect(() => parseGlbJson(bytes)).toThrow(/truncated chunk/i);
  });

  it('composes parent matrices with rotated, negatively scaled child TRS', () => {
    const bytes = makeGlb({
      scene: 1,
      scenes: [{ nodes: [2] }, { nodes: [0] }],
      nodes: [
        { name: 'root', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1], children: [1] },
        { name: 'part', mesh: 0, translation: [1, 2, 3], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [-2, 3, 1] },
        { name: 'outside-default-scene', mesh: 0, translation: [1000, 1000, 1000] },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ min: [0, 0, 0], max: [1, 2, 3] }],
    });
    const summary = summarizeGlb(bytes);
    expect(summary.namedNodes).toEqual(['root', 'part', 'outside-default-scene']);
    expect(summary.rootNodes).toEqual(['root']);
    const bounds = summary.boundingBox!;
    [5, 20, 33].forEach((value, axis) => expect(bounds.min[axis]).toBeCloseTo(value));
    [11, 22, 36].forEach((value, axis) => expect(bounds.max[axis]).toBeCloseTo(value));
    expect(nodeBounds(bytes)).toEqual({ root: bounds, part: bounds });
    expect(nodeBounds(bytes, ['part'])).toEqual(bounds);
    expect(nodeBounds(bytes, ['outside-default-scene'])).toEqual({
      min: [1000, 1000, 1000], max: [1001, 1002, 1003],
    });
  });

  it('includes own meshes and unnamed descendants, but omits empty subtrees', () => {
    const bytes = makeGlb({
      scenes: [{ nodes: [0] }],
      nodes: [
        { name: 'assembly', mesh: 0, translation: [10, 0, 0], children: [1, 2] },
        { mesh: 0, translation: [2, 3, 4], children: [3] },
        { name: 'empty' },
        { name: 'tip', mesh: 0, translation: [0, 2, 0] },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ min: [0, 0, 0], max: [1, 1, 1] }],
    });
    expect(nodeBounds(bytes)).toEqual({
      assembly: { min: [10, 0, 0], max: [13, 6, 5] },
      tip: { min: [12, 5, 4], max: [13, 6, 5] },
    });
    expect(nodeBounds(bytes, ['assembly', 'tip', 'assembly', 'missing'])).toEqual({
      min: [10, 0, 0], max: [13, 6, 5],
    });
    expect(nodeBounds(bytes, ['tip'])).toEqual({ min: [12, 5, 4], max: [13, 6, 5] });
    expect(nodeBounds(bytes, ['empty'])).toBeNull();
    expect(nodeBounds(bytes, [])).toBeNull();
  });

  it('unions distinct subtrees and all subtrees with a duplicate name', () => {
    const bytes = makeGlb({
      scenes: [{ nodes: [0, 1, 2] }],
      nodes: [
        { name: 'part', mesh: 0 },
        { name: 'part', mesh: 0, translation: [10, 0, 0] },
        { name: 'other', mesh: 0, translation: [0, 20, 0] },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ min: [0, 0, 0], max: [1, 1, 1] }],
    });
    expect(nodeBounds(bytes, ['part'])).toEqual({ min: [0, 0, 0], max: [11, 1, 1] });
    expect(nodeBounds(bytes, ['part', 'other'])).toEqual({ min: [0, 0, 0], max: [11, 21, 1] });
  });

  it('rejects cycles in scene and detached named subtrees', () => {
    const bytes = makeGlb({
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'part', children: [1] }, { children: [0] }],
    });
    expect(() => summarizeGlb(bytes)).toThrow('Invalid GLB: cycle at node 0.');
    expect(() => nodeBounds(bytes, ['part'])).toThrow('Invalid GLB: cycle at node 0.');
    expect(() => nodeBounds(makeGlb({ nodes: [{ name: 'part', children: [0] }] }), ['part']))
      .toThrow('Invalid GLB: cycle at node 0.');
  });

  it('prints node bounds with --nodes and includes them in JSON output', () => {
    const script = fileURLToPath(new URL('../inspect-glb.ts', import.meta.url));
    const file = fileURLToPath(new URL('../../seed/park-nx10/model.glb', import.meta.url));
    const text = spawnSync(process.execPath, ['--import', 'tsx', script, file, '--nodes'], {
      encoding: 'utf8',
    });
    expect(text.error).toBeUndefined();
    expect(text.status).toBe(0);
    expect(text.stdout).toMatch(/^head: min \[.+\], max \[.+\], size \[.+\]$/m);

    const json = spawnSync(process.execPath, ['--import', 'tsx', script, file, '--json'], {
      encoding: 'utf8',
    });
    expect(json.error).toBeUndefined();
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).nodeBounds.head).toEqual({
      min: expect.arrayContaining([expect.any(Number)]),
      max: expect.arrayContaining([expect.any(Number)]),
    });
  });

  it('reports unnamed roots and null bounds when no positions have bounds', () => {
    const summary = summarizeGlb(makeGlb({ scenes: [{ nodes: [0] }], nodes: [{}] }));
    expect(summary.rootNodes).toEqual(['']);
    expect(summary.namedNodes).toEqual([]);
    expect(summary.duplicateNames).toEqual([]);
    expect(summary.boundingBox).toBeNull();
    expect(summary.nodeBounds).toEqual({});
  });
});

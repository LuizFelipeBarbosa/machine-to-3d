import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGlbJson, summarizeGlb } from './glb.js';

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
  });

  it('reports unnamed roots and null bounds when no positions have bounds', () => {
    const summary = summarizeGlb(makeGlb({ scenes: [{ nodes: [0] }], nodes: [{}] }));
    expect(summary.rootNodes).toEqual(['']);
    expect(summary.namedNodes).toEqual([]);
    expect(summary.duplicateNames).toEqual([]);
    expect(summary.boundingBox).toBeNull();
  });
});
